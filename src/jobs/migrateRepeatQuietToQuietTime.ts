/**
 * src/jobs/migrateRepeatQuietToQuietTime.ts
 *
 * One-shot startup migration: promote every automation's per-action
 * `repeat.quiet` windows (business rule 44 — reminders paused overnight) into
 * the automation-level `NotificationRule.quietTime` (business rule 92 — every
 * people-facing send held, summary afterwards).
 *
 * THE ONE BEHAVIOUR CHANGE, on purpose. The windows are promoted in the
 * `followUps` mode — reminders still pause, as they did — and from now on the
 * escalation tiers pause with them, which rule 44 deliberately did not do and
 * the operator asked for on 2026-10-03 ("quiet only the repeat emails and the
 * escalation emails"). The first alert and the all-clear still send. Holding
 * everything and getting a summary email instead (`holds: "all"`) is one
 * click away in the automation's new Quiet time step, but it is the operator's
 * click: a migration must not start withholding first alerts overnight on a
 * configuration that never asked it to. The alternative — leaving a
 * reminder-only quiet time beside a send-holding one — would have meant two
 * controls called "quiet time" on one page that mean different things. So the
 * windows move, the old key is stripped, and an Event per converted
 * automation records what moved and what it now does.
 *
 * WHAT MOVES. Windows are collected from the rule-level `repeat.quiet`, from
 * every firing notify action's `repeat.quiet` and from every severity band's
 * actions' `repeat.quiet`, deduplicated by value and capped at
 * MAX_QUIET_WINDOWS (the first eight distinct ones, rule-level first). The
 * result holds every severity, sends its summary when the window ends and has
 * no recurrence threshold — the operator refines those in the wizard's new
 * Quiet time step. An automation that already carries a `quietTime` (an
 * install that ran a newer build, or an export imported after the cutover)
 * is left alone: only its stale `quiet` keys are stripped.
 *
 * WHAT DOES NOT. `AlertGroup.repeat.quiet` is left untouched and is simply
 * no longer read — a group has no quiet time of its own; its member
 * automations do. The sweep ignores a `quiet` key wherever it still appears.
 *
 * Idempotency: marker key "repeatQuietPromotedAt" in Setting, plus the fact
 * that a converted row has nothing left to convert (safe to re-run after a
 * restore). Recovery: delete the marker Setting and restart.
 */

import { logger } from "../utils/logger.js";
import { prisma } from "../db.js";
import { Prisma } from "../generated/prisma/client.js";
import { runInstrumentedJob } from "./_metrics.js";
import { hasRunMarker, stampRunMarker } from "./_runOnce.js";
import { logEvent } from "../services/eventLogService.js";
import { MAX_QUIET_WINDOWS, quietTimeConfigSchema, type QuietTimeConfig } from "../utils/quietTime.js";

export const PROMOTED_KEY = "repeatQuietPromotedAt";

type Blob = Record<string, unknown>;

const isObj = (v: unknown): v is Blob => typeof v === "object" && v !== null && !Array.isArray(v);

/** The windows a `repeat` blob carries, and the blob without its `quiet`. */
function splitRepeat(repeat: unknown): { windows: unknown[]; repeat: unknown; hadQuiet: boolean } {
  if (!isObj(repeat) || !("quiet" in repeat)) return { windows: [], repeat, hadQuiet: false };
  const { quiet, ...rest } = repeat;
  const windows = isObj(quiet) && Array.isArray(quiet.windows) ? quiet.windows : [];
  return { windows, repeat: rest, hadQuiet: true };
}

/** Walk a list of actions, stripping `repeat.quiet` and collecting windows. */
function stripActions(actions: unknown, collect: (w: unknown[]) => void): { actions: unknown; touched: boolean } {
  if (!Array.isArray(actions)) return { actions, touched: false };
  let touched = false;
  const out = actions.map((a) => {
    if (!isObj(a) || !("repeat" in a)) return a;
    const s = splitRepeat(a.repeat);
    if (!s.hadQuiet) return a;
    touched = true;
    collect(s.windows);
    return { ...a, repeat: s.repeat };
  });
  return { actions: out, touched };
}

export interface PromotionPlan {
  /** New value for `quietTime`, or undefined when the column is left alone. */
  quietTime?: QuietTimeConfig;
  repeat?: unknown;
  actions?: unknown;
  severityBands?: unknown;
  /** Distinct windows found across every location, before the cap. */
  windowsFound: number;
  /** Nothing to do for this row. */
  noop: boolean;
}

/**
 * What the migration will write for one rule row. Pure, exported for the
 * tests: the three "where does a repeat live" walks and the dedupe are the
 * parts worth pinning.
 */
export function planPromotion(row: {
  repeat: unknown;
  actions: unknown;
  severityBands: unknown;
  quietTime: unknown;
}): PromotionPlan {
  const seen = new Set<string>();
  const windows: unknown[] = [];
  const collect = (ws: unknown[]) => {
    for (const w of ws) {
      const key = JSON.stringify(w);
      if (seen.has(key)) continue;
      seen.add(key);
      windows.push(w);
    }
  };

  const plan: PromotionPlan = { windowsFound: 0, noop: true };

  const r = splitRepeat(row.repeat);
  if (r.hadQuiet) {
    collect(r.windows);
    plan.repeat = r.repeat;
    plan.noop = false;
  }
  const a = stripActions(row.actions, collect);
  if (a.touched) {
    plan.actions = a.actions;
    plan.noop = false;
  }
  if (Array.isArray(row.severityBands)) {
    let touched = false;
    const bands = row.severityBands.map((b) => {
      if (!isObj(b)) return b;
      const s = stripActions(b.actions, collect);
      if (!s.touched) return b;
      touched = true;
      return { ...b, actions: s.actions };
    });
    if (touched) {
      plan.severityBands = bands;
      plan.noop = false;
    }
  }

  plan.windowsFound = windows.length;
  // A rule that already has a quiet time keeps it — only the stale keys go.
  // Promoted in the FOLLOW-UPS mode: those windows were configured to pause
  // the chasing, and that is what they keep doing (now the escalation tiers
  // too). Holding the first alert and summarising is one click away in the
  // automation's Quiet time step, but it is the operator's click to make.
  if (windows.length > 0 && row.quietTime == null) {
    const parsed = quietTimeConfigSchema.safeParse({ windows: windows.slice(0, MAX_QUIET_WINDOWS), holds: "followUps" });
    // A malformed window set (hand-edited row) is dropped rather than
    // promoted: rule 44 already treated such a blob as "no quiet time", so
    // nothing is lost that was ever in force.
    if (parsed.success) plan.quietTime = parsed.data;
  }
  return plan;
}

export async function migrateRepeatQuietToQuietTime(): Promise<void> {
  if (await hasRunMarker(PROMOTED_KEY)) return;

  // Automations are operator-sized (tens to low hundreds): read them whole.
  const rows = await prisma.notificationRule.findMany({
    select: { id: true, name: true, repeat: true, actions: true, severityBands: true, quietTime: true },
    orderBy: { name: "asc" },
  });

  let converted = 0;
  let stripped = 0;
  const writes: Prisma.PrismaPromise<unknown>[] = [];
  const events: Parameters<typeof logEvent>[0][] = [];
  for (const row of rows) {
    const plan = planPromotion(row);
    if (plan.noop) continue;
    const data: Prisma.NotificationRuleUpdateInput = {
      ...(plan.repeat !== undefined ? { repeat: plan.repeat as Prisma.InputJsonValue } : {}),
      ...(plan.actions !== undefined ? { actions: plan.actions as Prisma.InputJsonValue } : {}),
      ...(plan.severityBands !== undefined ? { severityBands: plan.severityBands as Prisma.InputJsonValue } : {}),
      ...(plan.quietTime ? { quietTime: plan.quietTime as unknown as Prisma.InputJsonValue } : {}),
    };
    writes.push(prisma.notificationRule.update({ where: { id: row.id }, data }));
    if (plan.quietTime) {
      converted++;
      events.push({
        action: "automation.quiet_time_migrated",
        resourceType: "notification-rule",
        resourceId: row.id,
        resourceName: row.name,
        actor: "system:migration",
        level: "warning",
        message:
          `Quiet time on "${row.name}" moved from its reminder settings to the automation's own Quiet time step: ` +
          `${plan.quietTime.windows.length} quiet period${plan.quietTime.windows.length === 1 ? "" : "s"}, holding reminders ` +
          `AND escalation emails (the first alert still sends). Open the automation to hold everything and get a ` +
          `summary email instead, narrow the severities, or set a summary time.`,
        details: {
          windows: plan.quietTime.windows,
          windowsFound: plan.windowsFound,
          ...(plan.windowsFound > MAX_QUIET_WINDOWS ? { droppedBeyondCap: plan.windowsFound - MAX_QUIET_WINDOWS } : {}),
        },
      });
    } else {
      stripped++;
    }
  }

  if (writes.length > 0) {
    // Event BEFORE data, as every migration here does: the update is what
    // makes the old location unrecoverable.
    for (const e of events) await logEvent(e).catch(() => {});
    await prisma.$transaction(writes);
  }

  await stampRunMarker(PROMOTED_KEY, { rulesConverted: converted, rulesStripped: stripped });
  if (converted > 0 || stripped > 0) {
    logger.info({ converted, stripped }, "Promoted per-action reminder quiet time to automation quiet time (business rule 92)");
  }
}

(async () => {
  try {
    await runInstrumentedJob("migrateRepeatQuietToQuietTime", migrateRepeatQuietToQuietTime);
  } catch (err) {
    logger.error({ err }, "quiet-time promotion failed — recovery: delete the repeatQuietPromotedAt Setting and restart");
  }
})();
