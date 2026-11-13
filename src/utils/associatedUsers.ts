/**
 * src/utils/associatedUsers.ts — the user sightings on `Asset.associatedUsers`
 * and the "last logged-on user" read from them (business rule 180).
 *
 * Three discovery paths report who uses a device: Intune's `usersLoggedOn`
 * (each user's last logon on the device), a FortiGate's live authenticated-
 * user table (FSSO / RSSO / captive portal / firewall auth) and its device
 * inventory's `user` field. Each is a SIGHTING — an account, the time the
 * source saw it on the device, and which source said so. They all land in
 * one list, merged here, so the newest entry is the last logged-on user
 * whichever source saw it.
 *
 * The time on an entry is when the SOURCE saw the user, never when Polaris
 * read it: a remembered-but-offline inventory row, or an Intune record of a
 * logon three weeks ago, must not read as "logged on now". Only-advance per
 * account, so an older sighting arriving later cannot move a newer one back.
 *
 * The list is bounded (business rule 158 — nothing grows without a limit): a
 * shared PC or a kiosk sees a new account every shift, so only the
 * MAX_ASSOCIATED_USERS newest are kept.
 */

/** One entry of `Asset.associatedUsers`. */
export interface AssociatedUser {
  user: string;
  domain?: string;
  /** ISO time the source saw this account on the device. */
  lastSeen: string;
  /** "intune" | "fortigate-auth" | "device-inventory" (older rows may carry others). */
  source?: string;
}

/** A sighting a discovery path reports, before it is merged. */
export interface UserSighting {
  /** As the source spelled it: `DOMAIN\user`, a UPN, or a bare name. */
  account: string;
  seenAt: Date;
  source: string;
}

/** How many entries an asset keeps — the newest win. */
export const MAX_ASSOCIATED_USERS = 25;

/**
 * Split an account the way the list stores it. `DOMAIN\user` keeps the domain
 * apart (the shape FortiOS reports for FSSO users); a UPN or a bare name is
 * the user with no domain. Trimmed; null for an empty account.
 */
export function splitAccountName(raw: unknown): { user: string; domain?: string } | null {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return null;
  const slash = s.indexOf("\\");
  if (slash > 0 && slash < s.length - 1) {
    return { user: s.slice(slash + 1).trim(), domain: s.slice(0, slash).trim() };
  }
  const user = s.replace(/^\\+|\\+$/g, "").trim();
  return user ? { user } : null;
}

const accountKey = (user: string, domain: string | undefined): string =>
  `${(domain ?? "").toLowerCase()}\\${user.toLowerCase()}`;

function timeOf(iso: string | undefined): number {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : 0;
}

/**
 * Merge sightings into a stored list. Accounts compare case-blind (FSSO
 * upper-cases names Intune reports in mixed case); a known account takes a
 * sighting only when it is NEWER, and then takes its source and spelling too.
 * The result is newest-first and capped. `changed` is false when nothing
 * would be written — the caller skips the update.
 */
export function mergeUserSightings(
  existing: unknown,
  sightings: ReadonlyArray<UserSighting>,
): { list: AssociatedUser[]; changed: boolean } {
  const list: AssociatedUser[] = Array.isArray(existing)
    ? (existing as unknown[])
        .filter((e): e is AssociatedUser => !!e && typeof (e as AssociatedUser).user === "string" && !!(e as AssociatedUser).user)
        .map((e) => ({ ...e }))
    : [];
  const byKey = new Map(list.map((e) => [accountKey(e.user, e.domain), e]));
  let changed = false;
  for (const s of sightings) {
    const name = splitAccountName(s.account);
    const seenMs = s.seenAt.getTime();
    if (!name || !Number.isFinite(seenMs) || seenMs <= 0) continue;
    const key = accountKey(name.user, name.domain);
    const prior = byKey.get(key);
    if (prior) {
      if (seenMs <= timeOf(prior.lastSeen)) continue;
      prior.user = name.user;
      if (name.domain) prior.domain = name.domain; else delete prior.domain;
      prior.lastSeen = s.seenAt.toISOString();
      prior.source = s.source;
    } else {
      const entry: AssociatedUser = { user: name.user, ...(name.domain ? { domain: name.domain } : {}), lastSeen: s.seenAt.toISOString(), source: s.source };
      list.push(entry);
      byKey.set(key, entry);
    }
    changed = true;
  }
  // A stored list that is out of order or over the cap is put right by the
  // next write; on its own it is not a reason to write.
  list.sort((a, b) => timeOf(b.lastSeen) - timeOf(a.lastSeen));
  return { list: list.slice(0, MAX_ASSOCIATED_USERS), changed };
}

/** The last logged-on user: the newest entry, or null for an empty list. */
export function lastLoggedOnUser(list: unknown): AssociatedUser | null {
  if (!Array.isArray(list)) return null;
  let best: AssociatedUser | null = null;
  for (const e of list as AssociatedUser[]) {
    if (!e || typeof e.user !== "string" || !e.user) continue;
    if (!best || timeOf(e.lastSeen) > timeOf(best.lastSeen)) best = e;
  }
  return best;
}
