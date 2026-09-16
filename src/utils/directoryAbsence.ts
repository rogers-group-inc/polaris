/**
 * src/utils/directoryAbsence.ts
 *
 * Pure decisions behind the AD / Entra ID disappearance sweep — "this device
 * left the directory, or was disabled in it, so the asset it owns is
 * decommissioned" (business rule 70).
 *
 * The sweep itself lives in `discovery/discoveryEngine.ts` inside a DB-bound
 * private helper that nothing can unit-test, so the two judgements that
 * actually decide whether a fleet gets decommissioned live here instead — the
 * same split `vcenterService.ts` uses for the vCenter sweep
 * (`vcenterSweepBlockedReason` / `partitionStaleVcenterSources`).
 *
 * Nothing here talks to Prisma, Graph or LDAP.
 */

/** What a directory read says about one existing AssetSource row. */
export interface DirectoryRowFates<T> {
  /** Still in the directory and enabled — leave it alone. */
  alive: T[];
  /** Gone from the directory read entirely — the row is stale provenance. */
  gone: T[];
  /** Still in the directory, but the account/device is disabled there. */
  disabled: T[];
}

/**
 * Sort existing directory AssetSource rows against what this run actually read.
 *
 * `present` is the RAW identifier set — every device the directory returned,
 * taken BEFORE the operator's name/OU include-exclude filter and BEFORE the
 * `includeDisabled=false` skip. Both exclusions are configuration, not
 * deletion: a filter edit must not read as "the fleet was deleted" (the same
 * call `partitionStaleVcenterSources` makes with `presentVmMorefs`), and a
 * disabled device that `includeDisabled=false` dropped before the sync ever
 * saw it must land in `disabled`, not in `gone` — it still exists, it is just
 * switched off, and the two get different treatment (a disabled device keeps
 * its source row; a deleted one loses it).
 *
 * Matching is case-insensitive: Entra deviceIds and AD objectGUIDs are stored
 * lowercased on the source row, but neither directory guarantees the case it
 * hands back.
 */
export function classifyDirectoryRows<T extends { externalId: string }>(
  rows: T[],
  present: Iterable<string>,
  disabled: Iterable<string>,
): DirectoryRowFates<T> {
  const presentSet = toLowerSet(present);
  const disabledSet = toLowerSet(disabled);
  const fates: DirectoryRowFates<T> = { alive: [], gone: [], disabled: [] };
  for (const row of rows) {
    const key = row.externalId.toLowerCase();
    if (!presentSet.has(key)) fates.gone.push(row);
    else if (disabledSet.has(key)) fates.disabled.push(row);
    else fates.alive.push(row);
  }
  return fates;
}

function toLowerSet(values: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const v of values) out.add(v.toLowerCase());
  return out;
}

/**
 * The catastrophic-shrink guard, business rule 35(c)'s shape applied to assets
 * instead of contacts (`directorySyncService.deleteExceedsGuard` is the same
 * formula on the address book).
 *
 * `classifyDirectoryRows` already covers the innocent absences it can SEE —
 * an include/exclude edit, a disabled account. It cannot see the one that
 * matters most here: `baseDn` narrowed, an OU delegated away, a service
 * principal that lost `Device.Read.All` on half the tenant. Each of those
 * returns a well-formed, complete, non-empty read that is simply missing most
 * of the estate, and absence is the whole signal this sweep acts on.
 *
 * The floor matters as much as the ratio: on a 40-machine lab 20 % is eight
 * rows, and refusing ordinary turnover would need an operator every time a
 * laptop is retired. What is being guarded against is categorical, not
 * incremental — so the guard trips on scale, and everything under it flows.
 */
const ABSENCE_GUARD_MIN = 50;
const ABSENCE_GUARD_RATIO = 0.2;

/** True when a disappearance set that large should be refused outright. */
export function absenceExceedsGuard(goneCount: number, ownedCount: number): boolean {
  return goneCount > Math.max(ABSENCE_GUARD_MIN, Math.floor(ownedCount * ABSENCE_GUARD_RATIO));
}
