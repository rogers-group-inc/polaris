/**
 * Platform lifecycle: the dataset shape, its Zod schema, and the pure grading
 * function that turns "what is installed" + "what the dataset says" into a
 * state and a severity.
 *
 * No I/O here. The file read, the host probes and the assembly live in
 * src/services/platformLifecycleService.ts; the data itself is the committed,
 * human-reviewed src/data/platformEol.json (refresh procedure:
 * .claude/skills/polaris-tech-lifecycle/references/eol-dataset.md).
 */
import { z } from "zod";
import { compareTracks, deriveTrack, type TrackGranularity } from "./platformVersions.js";

// ─── Dataset schema ───────────────────────────────────────────────────

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

export const trackSchema = z.object({
  track: z.string().min(1),
  released: isoDate.optional(),
  /** null = supported with no announced end. Absent = unknown. */
  eol: isoDate.nullable().optional(),
  /** End of full/active support, where a vendor distinguishes it (RHEL). */
  activeSupportEnds: isoDate.nullable().optional(),
  /** Paid or volunteer extension past `eol` (RHEL ELS, Ubuntu ESM, Debian LTS). */
  extendedSupport: isoDate.nullable().optional(),
  lts: z.boolean().optional(),
  prerelease: z.boolean().optional(),
  note: z.string().optional(),
});

export const technologySchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  kind: z.enum(["runtime", "database", "extension", "toolchain", "proxy", "os", "library"]),
  trackGranularity: z.enum(["major", "major.minor"]),
  /**
   * dated  — real published EOL dates; gradeable against a calendar.
   * compat — lifecycle is a compatibility horizon, not a date (TimescaleDB).
   * none   — the vendor publishes nothing gradeable (npm libraries).
   */
  policy: z.enum(["dated", "compat", "none"]),
  /** Network-reachable and unpatchable once EOL: drives critical vs warning. */
  securityExposed: z.boolean(),
  polarisMinimum: z.string().nullable().optional(),
  polarisTarget: z.string().nullable().optional(),
  polarisMaximumTested: z.string().nullable().optional(),
  upgradePlaybook: z.string().nullable().optional(),
  source: z.string().min(1),
  sourceCheckedOn: isoDate,
  confidence: z.enum(["vendor", "aggregator"]),
  notes: z.string().optional(),
  tracks: z.array(trackSchema),
});

export const playbookSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  docAnchor: z.string().optional(),
  risk: z.enum(["low", "medium", "high"]).optional(),
  steps: z.array(z.string()).default([]),
  files: z.array(z.string()).default([]),
});

export const platformEolDatasetSchema = z.object({
  schemaVersion: z.number().int().positive(),
  reviewedAt: isoDate,
  reviewedBy: z.string().optional(),
  sourceNotes: z.string().optional(),
  technologies: z.array(technologySchema).min(1),
  playbooks: z.array(playbookSchema).default([]),
});

export type PlatformEolDataset = z.infer<typeof platformEolDatasetSchema>;
export type PlatformTechnology = z.infer<typeof technologySchema>;
export type PlatformTrack = z.infer<typeof trackSchema>;
export type PlatformPlaybook = z.infer<typeof playbookSchema>;

// ─── Grading ──────────────────────────────────────────────────────────

/**
 * Thresholds. Named because they appear in operator-facing copy and in tests.
 *
 * 180 days is roughly "next planning cycle" and 90 is roughly "this quarter",
 * which is the resolution a maintenance window is actually scheduled at.
 */
export const LIFECYCLE_WATCH_DAYS = 180;
export const LIFECYCLE_WARNING_DAYS = 90;

export type LifecycleState =
  /** No observed version, or no matching track in the dataset. */
  | "unknown"
  /** An optional component that is legitimately absent. */
  | "not_installed"
  /** Newer than anything Polaris has tested on. */
  | "ahead_of_tested"
  /** Supported, and not near its end. */
  | "current"
  /**
   * Supported, but its end of life is within LIFECYCLE_WATCH_DAYS. A CLOCK:
   * the date is doing the talking, and it only moves one way.
   */
  | "aging"
  /**
   * Supported and not near its end, but below `polarisTarget`. A PREFERENCE,
   * not a deadline — deliberately a separate state from `aging`.
   *
   * These were one state at first, and that was a mistake caught in the field:
   * a card showing "Aging" for a Java 17 with 386 days of support left was read
   * as "needs upgrading", when the only thing true of it was that the dataset
   * named a newer version. Same severity, very different meaning, so they get
   * different labels. If a component genuinely nears its end, `aging` above
   * says so on its own with a date attached.
   */
  | "behind_target"
  /** EOL within LIFECYCLE_WARNING_DAYS. */
  | "approaching_eol"
  /** Past EOL but inside a paid/volunteer extension. */
  | "eol_extended"
  /** Past EOL. No more security fixes. */
  | "eol"
  /** Below the minimum Polaris supports — this install is misconfigured. */
  | "below_minimum";

export type LifecycleSeverity = "none" | "watch" | "warning" | "critical";

export interface LifecycleGrade {
  state: LifecycleState;
  severity: LifecycleSeverity;
  /** Track the observed version was resolved to, e.g. "20" or "1.22". */
  track: string | null;
  eolAt: string | null;
  activeSupportEndsAt: string | null;
  extendedSupportUntil: string | null;
  daysUntilEol: number | null;
  /**
   * Caps the severity this grade may contribute to the capacity snapshot.
   *
   * Set to "warning" for upstream EOL. An EOL runtime is real and reaches the
   * card in red, an error-level Event and email — but it is true for months
   * and clears only in a maintenance window, so letting it hold the
   * non-dismissible sidebar alert open would train operators to look past a
   * banner that also means "a disk is full, act in minutes". below_minimum
   * gets NO cap: that one is a misconfiguration of this install, one package
   * command from fixed, and deserves the full treatment.
   */
  capacitySeverityCap?: "warning";
}

const DAY_MS = 86_400_000;

/**
 * Whole days from `now` to a date-only ISO string.
 *
 * `now` is floored to UTC midnight first, deliberately. The dataset holds
 * date-only values and a vendor that says "supported until 2026-04-30" means
 * supported *through* the 30th. Differencing a date-only midnight against a
 * mid-afternoon `now` and flooring would make the version read as already EOL
 * on its own last supported day — a whole day of false alarm, on the one day
 * an operator is most likely to be looking.
 */
function daysBetween(nowMs: number, toIso: string): number {
  const midnight = Math.floor(nowMs / DAY_MS) * DAY_MS;
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - midnight) / DAY_MS);
}

/** Find the dataset track matching an observed version. */
export function findTrack(tech: PlatformTechnology, observedVersion: string | null): PlatformTrack | null {
  if (!observedVersion) return null;
  const t = deriveTrack(observedVersion, tech.trackGranularity as TrackGranularity);
  if (!t) return null;
  return tech.tracks.find((x) => x.track === t) ?? null;
}

/**
 * Grade one observed component.
 *
 * `now` is injected rather than read from the clock so the whole state table
 * is testable at its exact day boundaries.
 */
export function gradeComponent(
  tech: PlatformTechnology,
  observedVersion: string | null,
  now: Date,
  opts: { installed?: boolean } = {},
): LifecycleGrade {
  const nowMs = now.getTime();
  const track = observedVersion
    ? deriveTrack(observedVersion, tech.trackGranularity as TrackGranularity)
    : null;

  const base: LifecycleGrade = {
    state: "unknown",
    severity: "none",
    track,
    eolAt: null,
    activeSupportEndsAt: null,
    extendedSupportUntil: null,
    daysUntilEol: null,
  };

  if (opts.installed === false) return { ...base, state: "not_installed" };

  // A technology whose vendor publishes nothing gradeable is reported, never
  // graded. Inventing a verdict here is how a warning loses its credibility.
  if (tech.policy !== "dated") return base;
  if (!track) return base;

  // Below Polaris's own floor beats everything else: it says this install is
  // misconfigured right now, which is actionable today and independent of any
  // upstream calendar.
  if (tech.polarisMinimum && compareTracks(track, tech.polarisMinimum) < 0) {
    const row = tech.tracks.find((x) => x.track === track) ?? null;
    return {
      ...base,
      state: "below_minimum",
      severity: "critical",
      eolAt: row?.eol ?? null,
      activeSupportEndsAt: row?.activeSupportEnds ?? null,
      extendedSupportUntil: row?.extendedSupport ?? null,
      daysUntilEol: row?.eol ? daysBetween(nowMs, row.eol) : null,
    };
  }

  const row = tech.tracks.find((x) => x.track === track);
  if (!row) {
    // A version newer than anything the dataset knows is more likely a stale
    // dataset than a problem — but say so rather than claiming "current".
    if (tech.polarisMaximumTested && compareTracks(track, tech.polarisMaximumTested) > 0) {
      return { ...base, state: "ahead_of_tested", severity: "watch" };
    }
    return base;
  }

  const eolAt = row.eol ?? null;
  const extendedSupportUntil = row.extendedSupport ?? null;
  const activeSupportEndsAt = row.activeSupportEnds ?? null;
  const daysUntilEol = eolAt ? daysBetween(nowMs, eolAt) : null;

  const withDates = (over: Partial<LifecycleGrade>): LifecycleGrade => ({
    ...base,
    eolAt,
    activeSupportEndsAt,
    extendedSupportUntil,
    daysUntilEol,
    ...over,
  });

  if (tech.polarisMaximumTested && compareTracks(track, tech.polarisMaximumTested) > 0) {
    return withDates({ state: "ahead_of_tested", severity: "watch" });
  }

  if (daysUntilEol !== null && daysUntilEol < 0) {
    if (extendedSupportUntil && daysBetween(nowMs, extendedSupportUntil) >= 0) {
      return withDates({ state: "eol_extended", severity: "warning", capacitySeverityCap: "warning" });
    }
    return withDates({
      state: "eol",
      severity: tech.securityExposed ? "critical" : "warning",
      capacitySeverityCap: "warning",
    });
  }

  if (daysUntilEol !== null && daysUntilEol <= LIFECYCLE_WARNING_DAYS) {
    return withDates({ state: "approaching_eol", severity: "warning" });
  }

  if (daysUntilEol !== null && daysUntilEol <= LIFECYCLE_WATCH_DAYS) {
    return withDates({ state: "aging", severity: "watch" });
  }

  // Supported, not near its end, but below the track Polaris names as its
  // target. Reported as `behind_target`, NOT `aging`: there is no clock on this
  // one, and conflating the two made a component with over a year of support
  // read as overdue. Same watch severity either way, so nothing about alerting
  // changes — only what the operator is told.
  if (tech.polarisTarget && compareTracks(track, tech.polarisTarget) < 0) {
    return withDates({ state: "behind_target", severity: "watch" });
  }

  return withDates({ state: "current", severity: "none" });
}

/** Highest of a set of lifecycle severities. */
export function maxSeverity(list: LifecycleSeverity[]): LifecycleSeverity {
  const order: LifecycleSeverity[] = ["none", "watch", "warning", "critical"];
  return list.reduce<LifecycleSeverity>((acc, s) => (order.indexOf(s) > order.indexOf(acc) ? s : acc), "none");
}
