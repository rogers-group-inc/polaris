/**
 * src/utils/sortByTime.ts — sort a list by a timestamp field, parsing each
 * timestamp ONCE.
 *
 * Replaces the comparator `(a, b) => new Date(b.lastSeen).getTime() -
 * new Date(a.lastSeen).getTime()`, which was pasted at eight sites (the MAC and
 * user history lists in discovery, the agent MAC merge, the agent build
 * prune, path-check sample ingest; CQ-B053, 2026-11-05). That comparator built
 * two Dates per comparison, and on a missing or unparseable timestamp it
 * returned NaN — which Array.prototype.sort treats as "equal to everything", an
 * inconsistent comparator whose result depends on the engine. Here a missing or
 * invalid time sorts as the OLDEST, in either direction's sense: last for
 * "newest first", first for "oldest first".
 *
 * Sorts IN PLACE and returns the same array (like Array.prototype.sort), and is
 * stable, so equal timestamps keep their incoming order.
 */

type TimeLike = Date | string | number | null | undefined;

function timeOf(v: TimeLike): number {
  if (v === null || v === undefined || v === "") return -Infinity;
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isNaN(t) ? -Infinity : t;
}

function sortByTime<T>(list: T[], at: (item: T) => TimeLike, sign: 1 | -1): T[] {
  const keyed = list.map((item, i) => ({ item, i, t: timeOf(at(item)) }));
  keyed.sort((a, b) => {
    if (a.t === b.t) return a.i - b.i;
    return a.t < b.t ? -sign : sign;
  });
  for (let i = 0; i < keyed.length; i++) list[i] = keyed[i].item;
  return list;
}

/** Newest first; a missing or invalid time sorts last. In place. */
export function sortNewestFirst<T>(list: T[], at: (item: T) => TimeLike): T[] {
  return sortByTime(list, at, -1);
}

/** Oldest first; a missing or invalid time sorts first. In place. */
export function sortOldestFirst<T>(list: T[], at: (item: T) => TimeLike): T[] {
  return sortByTime(list, at, 1);
}
