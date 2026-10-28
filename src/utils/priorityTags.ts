/**
 * src/utils/priorityTags.ts
 *
 * The five built-in Priority tags (business rule 136): one per alert severity,
 * seeded on every install, locked against rename / recolour / recategorise /
 * delete by anyone. Only their auto-assign device filter is editable, and a
 * filter only ADDS the tag — operators still put them on assets and
 * interfaces by hand.
 *
 * Kept in utils, not in notificationTypes, because both the tag registry
 * routes and the automation engine read it and neither should import the
 * other. The severity strings are the SEVERITIES of notificationTypes, in the
 * same ascending order; tests/unit/priorityTags.test.ts pins the two together.
 */

export const PRIORITY_TAG_CATEGORY = "Priority";

/** Ascending, the order of SEVERITIES. The name is the tag; the severity is
 *  what an automation whose severity follows the Priority tag raises. */
export const PRIORITY_TAGS = [
  { name: "Notice", severity: "notice" },
  { name: "Informational", severity: "informational" },
  { name: "Warning", severity: "warning" },
  { name: "Serious", severity: "serious" },
  { name: "Critical", severity: "critical" },
] as const;

export type PrioritySeverity = (typeof PRIORITY_TAGS)[number]["severity"];

/** The registry colour a built-in Priority tag always carries — the severity's
 *  theme token (`severity:<level>`, tagColorCss in public/js/app.js). */
export function priorityTagColor(severity: PrioritySeverity): string {
  return `severity:${severity}`;
}

/** The built-in entry for a registry tag name, or null. Exact name: the
 *  registry is case-sensitive, and only the seeded spelling is locked. */
export function builtInPriorityTag(name: string): (typeof PRIORITY_TAGS)[number] | null {
  return PRIORITY_TAGS.find((p) => p.name === name) ?? null;
}

/**
 * The severity the HIGHEST Priority tag in `tags` names, or null when none of
 * them is a Priority tag. Matched case-insensitively, the way every tag
 * condition matches, so a hand-typed "critical" on an asset counts. Highest
 * wins because a device tagged both Warning and Critical is a critical device;
 * picking the lower would quietly demote it.
 */
export function prioritySeverityOf(tags: readonly string[] | null | undefined): PrioritySeverity | null {
  let best = -1;
  for (const t of tags ?? []) {
    const i = PRIORITY_TAGS.findIndex((p) => p.name.toLowerCase() === t.trim().toLowerCase());
    if (i > best) best = i;
  }
  return best >= 0 ? PRIORITY_TAGS[best]!.severity : null;
}
