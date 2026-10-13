/**
 * src/jobs/auditStoredRegexes.ts — business rule 116: say which STORED
 * operator regexes the linear-time engine cannot run.
 *
 * Runs once at boot. Every finding gets one warning `regex.pattern_unusable`
 * Event, unless one already exists for the same (source, row, pattern) — a
 * restart does not repeat the warning, and an edited pattern is a new key.
 * The capacity card's watch reason (capacityService) keeps the count visible
 * between restarts. Read-only apart from the Events. Not marker-guarded: the
 * answer changes as operators edit their patterns.
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { logEventsBatch } from "../services/eventLogService.js";
import { runInstrumentedJob } from "./_metrics.js";
import { findUnusableStoredPatterns } from "../services/storedRegexAuditService.js";

const ACTION = "regex.pattern_unusable";

async function auditStoredRegexes(): Promise<void> {
  try {
    await runInstrumentedJob("auditStoredRegexes", async () => {
      const findings = await findUnusableStoredPatterns();
      if (findings.length === 0) return;
      const already = await prisma.event.findMany({
        where: { action: ACTION, resourceId: { in: findings.map((f) => f.key) } },
        select: { resourceId: true },
      });
      const seen = new Set(already.map((e) => e.resourceId));
      const fresh = findings.filter((f) => !seen.has(f.key));
      if (fresh.length === 0) return;
      await logEventsBatch(fresh.map((f) => ({
        action: ACTION,
        level: "warning" as const,
        resourceType: "regex-pattern",
        resourceId: f.key,
        resourceName: f.name ?? f.source,
        actor: "system:regex",
        message: `${f.source}${f.name ? ` "${f.name}"` : ""} has a pattern Polaris now skips: ${f.problem}`,
        details: { source: f.source, rowId: f.id, pattern: f.pattern },
      })));
      logger.warn({ count: fresh.length }, "Stored regex patterns the RE2 engine cannot run — they are skipped until rewritten (rule 116)");
    });
  } catch (err) {
    logger.error(err, "auditStoredRegexes failed");
  }
}

void auditStoredRegexes();
