/**
 * src/services/directorySyncService.ts
 *
 * Scheduled sync of the organization's Global Address List into the Polaris
 * address book. See business rule 35.
 *
 * SYNCED, unlike its sibling. `directorySearchService` answers one typeahead
 * live and persists NOTHING; this materializes the roster as `Contact` rows so
 * alert recipients and device ownership can be picked from the company
 * directory without an operator curating the book by hand. That reverses the
 * deliberate "never store it" posture the search path was built with, and the
 * mitigations below are the price of the reversal — not decoration.
 *
 * PII POSTURE. Every non-excluded GAL entry lands in Postgres carrying a
 * primary SMTP address, display name, job title, department and phone, plus a
 * per-source `observed` blob holding the AD distinguished name or Entra object
 * id. All of it rides every pg_dump the install produces, including the
 * off-host backup copies.
 *
 * **None of it may reach `Event.details` or the logs.** Events are readable by
 * anyone holding events access and are shipped off-host by the syslog (CEF) and
 * SFTP archivers, so this service's Events carry COUNTS ONLY and its warnings
 * name integrations, never people. The one deliberate exception lives in
 * contactService: `contact.adopted` names the address, exactly as
 * `contact.created` already does — a single act by a person is audited by name,
 * bulk machine activity is anonymous. Do not "fix" that asymmetry.
 *
 * Opt-in per integration (`config.enableDirectorySync`, default false),
 * deliberately SEPARATE from `enableDirectorySearch`: they need the same
 * directory grants but they are not the same decision, because one reads and
 * one stores.
 */

import { matchesWildcard } from "../utils/integrationFilter.js";
import { prisma } from "../db.js";
import { logEvent } from "./eventLogService.js";
import { bumpContactCache, normalizeContactEmail } from "./contactService.js";
import { listDirectorySources } from "./directorySearchService.js";
import { listDirectoryPeople as listDirectoryPeopleEntra } from "./entraIdService.js";
import { listDirectoryPeople as listDirectoryPeopleAd } from "./activeDirectoryService.js";

/**
 * One directory entry as the bulk readers report it. A superset of the live
 * search's `DirectoryHit`: the extra fields are either stored on the contact
 * (jobTitle / department / phone) or exist only so `directoryExclusionReason`
 * can judge the entry (disabled / mailboxKind / distinguishedName / groupDns).
 */
export interface DirectoryPerson {
  /** Graph object id, or AD objectGUID hex. Stable across renames. */
  externalId: string;
  email: string;
  name: string | null;
  jobTitle: string | null;
  department: string | null;
  phone: string | null;
  description: string | null;
  kind: "person" | "group";
  /** AD only — what the OU include/exclude patterns match against. */
  distinguishedName?: string;
  /** True when the directory says the account is disabled. */
  disabled?: boolean;
  /**
   * AD reports this honestly via msExchRecipientTypeDetails. Graph does NOT
   * expose a mailbox type on /users at all, so the Entra reader leaves this
   * "unknown" rather than guessing — see the exclusion note below.
   */
  mailboxKind?: "user" | "shared" | "room" | "equipment" | "unknown";
  /** Group DNs (AD) or group object ids (Entra) this entry belongs to. */
  groupDns?: string[];
}

/** The operator's exclusion filter, normalized. */
export interface DirectorySyncFilter {
  excludeDisabled: boolean;
  excludeSharedMailboxes: boolean;
  includeGroups: boolean;
  includeOrgContacts: boolean;
  /** AD OU patterns matched against the DN. Include WINS over exclude. */
  ouInclude: string[];
  ouExclude: string[];
  /** Group DNs / object ids whose members are excluded. */
  groupExclude: string[];
  /** Email domains, without the "@". Include WINS over exclude. */
  domainInclude: string[];
  domainExclude: string[];
  /** Glob-lite patterns matched against display name AND address. */
  nameExclude: string[];
  /** Hard cap on entries read per integration per run. */
  maxEntries: number;
}

export const DIRECTORY_SYNC_DEFAULT_MAX_ENTRIES = 20_000;
export const DIRECTORY_SYNC_MAX_ENTRIES_CEILING = 50_000;

function strArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim())
    .filter((x) => x !== "");
}

function bool(raw: unknown, fallback: boolean): boolean {
  return typeof raw === "boolean" ? raw : fallback;
}

/**
 * Read the `directorySync` config block into a filter, applying defaults.
 *
 * Defaults are deliberately conservative on the two that REMOVE people
 * (disabled accounts and shared mailboxes are excluded) and permissive on the
 * one that adds a whole class (`includeGroups`), because a distribution list is
 * usually exactly what an operator wants to alert. Org contacts default OFF:
 * they are external parties, and mailing a vendor's shared address because it
 * happened to be in the GAL is not a mistake worth making by default.
 */
export function normalizeDirectorySyncFilter(raw: unknown): DirectorySyncFilter {
  const c = (raw ?? {}) as Record<string, unknown>;
  const cap = Number(c.maxEntries);
  return {
    excludeDisabled: bool(c.excludeDisabled, true),
    excludeSharedMailboxes: bool(c.excludeSharedMailboxes, true),
    includeGroups: bool(c.includeGroups, true),
    includeOrgContacts: bool(c.includeOrgContacts, false),
    ouInclude: strArray(c.ouInclude),
    ouExclude: strArray(c.ouExclude),
    groupExclude: strArray(c.groupExclude),
    domainInclude: strArray(c.domainInclude).map((d) => d.replace(/^@/, "").toLowerCase()),
    domainExclude: strArray(c.domainExclude).map((d) => d.replace(/^@/, "").toLowerCase()),
    nameExclude: strArray(c.nameExclude),
    maxEntries: Number.isFinite(cap) && cap > 0
      ? Math.min(Math.trunc(cap), DIRECTORY_SYNC_MAX_ENTRIES_CEILING)
      : DIRECTORY_SYNC_DEFAULT_MAX_ENTRIES,
  };
}

/** The domain half of an address, lower-cased. "" when there isn't one. */
function domainOf(email: string): string {
  const at = email.lastIndexOf("@");
  return at < 0 ? "" : email.slice(at + 1).toLowerCase();
}

/**
 * Why this entry should NOT become a contact, or null to keep it.
 *
 * PURE, and returns a REASON rather than a boolean so the run summary can
 * report the dominant cause — "4,102 excluded" is not actionable, "4,102
 * excluded, mostly disabled accounts" is. The reason is a category, never a
 * name: it ends up in an Event, and Events must not carry directory PII.
 *
 * Include-wins-over-exclude for both OU and domain matches the existing AD
 * device-filter semantics (`filterDevices`), so an operator who has configured
 * one already knows how the other behaves.
 */
export function directoryExclusionReason(
  entry: DirectoryPerson,
  filter: DirectorySyncFilter,
): string | null {
  if (!entry.email) return "no email address";

  if (entry.kind === "group" && !filter.includeGroups) return "distribution list";

  if (filter.excludeDisabled && entry.disabled === true) return "disabled account";

  // Only ever excludes on a POSITIVE identification. "unknown" is what the
  // Entra reader reports for every user, because Graph cannot answer this
  // without a per-mailbox call; treating unknown as shared would silently drop
  // the entire tenant.
  if (
    filter.excludeSharedMailboxes &&
    entry.mailboxKind &&
    entry.mailboxKind !== "user" &&
    entry.mailboxKind !== "unknown"
  ) {
    return `${entry.mailboxKind} mailbox`;
  }

  const dn = entry.distinguishedName ?? "";
  if (filter.ouInclude.length > 0) {
    if (!dn || !filter.ouInclude.some((p) => matchesWildcard(p, dn))) return "outside the included OUs";
  } else if (filter.ouExclude.length > 0 && dn) {
    if (filter.ouExclude.some((p) => matchesWildcard(p, dn))) return "in an excluded OU";
  }

  const domain = domainOf(entry.email);
  if (filter.domainInclude.length > 0) {
    if (!filter.domainInclude.includes(domain)) return "outside the included domains";
  } else if (filter.domainExclude.length > 0 && filter.domainExclude.includes(domain)) {
    return "in an excluded domain";
  }

  if (filter.groupExclude.length > 0 && entry.groupDns?.length) {
    const groups = entry.groupDns.map((g) => g.toLowerCase());
    if (filter.groupExclude.some((g) => groups.includes(g.toLowerCase()))) {
      return "member of an excluded group";
    }
  }

  if (filter.nameExclude.length > 0) {
    const name = entry.name ?? "";
    if (filter.nameExclude.some((p) => matchesWildcard(p, name) || matchesWildcard(p, entry.email))) {
      return "matched a name exclusion";
    }
  }

  return null;
}

/** A provenance row's stored view, as the projection consumes it. */
export interface DirectorySourceView {
  sourceKind: string;
  observed: DirectoryPerson;
}

/** What a Contact row's directory-owned fields should be. */
export interface ProjectedContact {
  name: string | null;
  kind: string;
  jobTitle: string | null;
  department: string | null;
  phone: string | null;
  description: string | null;
  origin: string;
}

/**
 * Priority order when a person is present in more than one directory. Entra
 * outranks AD because a hybrid tenant's cloud objects are what HR-driven
 * provisioning writes to first; an on-prem-only person has no Entra source at
 * all and is unaffected by the ordering.
 */
const SOURCE_RANK: Record<string, number> = { entra: 0, ad: 1 };

function rankOf(sourceKind: string): number {
  return SOURCE_RANK[sourceKind] ?? 99;
}

/**
 * Project a contact's directory-owned fields from the set of sources feeding
 * it, highest-priority non-empty value winning PER FIELD.
 *
 * Projected rather than last-writer-wins for one specific reason: with two
 * directories that disagree about a job title, whichever ran most recently
 * would win, so the row would flip on every cycle — a write per contact per
 * run, an audit trail full of churn, and a value that is never stably either
 * answer. Deriving it from the full source set makes the result a function of
 * the inputs, so a steady state is genuinely steady. This is the
 * AssetSource / projectAssetFromSources shape at contact scale.
 *
 * Fixed and documented rather than operator-ordered; if an install ever
 * disagrees, an `assetSourcePriority`-style Setting is the extension point.
 */
export function projectContactFromSources(sources: DirectorySourceView[]): ProjectedContact {
  const ordered = [...sources].sort((a, b) => rankOf(a.sourceKind) - rankOf(b.sourceKind));

  const pick = (get: (o: DirectoryPerson) => string | null | undefined): string | null => {
    for (const s of ordered) {
      const v = get(s.observed ?? ({} as DirectoryPerson));
      if (typeof v === "string" && v.trim() !== "") return v.trim();
    }
    return null;
  };

  return {
    name: pick((o) => o.name),
    // A group in ANY source is a group: the distinction changes who an
    // operator thinks they are mailing, so the more specific claim wins over a
    // source that merely didn't say.
    kind: ordered.some((s) => s.observed?.kind === "group") ? "group" : "person",
    jobTitle: pick((o) => o.jobTitle),
    department: pick((o) => o.department),
    phone: pick((o) => o.phone),
    description: pick((o) => o.description),
    // The origin is the highest-priority source present, so a person who exists
    // in both directories badges as Entra — matching where the projected values
    // mostly came from.
    origin: ordered.length ? ordered[0].sourceKind : "manual",
  };
}


// ─── The pass ───────────────────────────────────────────────────────────────

/** What one run did. Counts only — nothing here may name a person. */
export interface DirectorySyncSummary {
  scanned: number;
  excluded: number;
  /** Dominant exclusion category, for the Event line. A category, never a name. */
  topExclusionReason: string | null;
  invalidAddress: number;
  created: number;
  updated: number;
  unchanged: number;
  deleted: number;
  /** Skipped because a Polaris user account already holds the address. */
  skippedUser: number;
  /** Skipped because an operator-curated contact already holds the address. */
  skippedManual: number;
  /** True when the deletion half was refused by the guard. */
  deleteSkippedGuard: boolean;
  /** True when the read hit the operator's entry cap. */
  capped: boolean;
  tookMs: number;
}

const EMPTY_SUMMARY: DirectorySyncSummary = {
  scanned: 0, excluded: 0, topExclusionReason: null, invalidAddress: 0,
  created: 0, updated: 0, unchanged: 0, deleted: 0,
  skippedUser: 0, skippedManual: 0, deleteSkippedGuard: false, capped: false, tookMs: 0,
};

/**
 * Batch size for the chunked writes. Mirrors presenceVerificationService's
 * WRITE_CHUNK: at twenty thousand contacts a per-row await is twenty thousand
 * sequential round trips.
 */
const WRITE_CHUNK = 200;

/**
 * The deletion guard. A run that scanned nothing, or that wants to remove more
 * than this share of what it owns, does not delete at all.
 *
 * The floor matters as much as the ratio: on a small address book 20% can be a
 * single row, and refusing a one-row delete would make ordinary turnover need
 * an operator. The failure being guarded against is categorical (a revoked
 * grant, an expired secret, an unreachable DC presenting as "everyone left the
 * company"), not incremental.
 */
const DELETE_GUARD_MIN = 50;
const DELETE_GUARD_RATIO = 0.2;

/** True when a delete set that large should be refused. */
export function deleteExceedsGuard(deleteCount: number, ownedCount: number): boolean {
  return deleteCount > Math.max(DELETE_GUARD_MIN, Math.floor(ownedCount * DELETE_GUARD_RATIO));
}

/**
 * Normalize an address without throwing.
 *
 * A GAL always contains malformed entries — a typo'd contact, a legacy object
 * with a display name in the mail attribute — and exactly one of them must not
 * abort a twenty-thousand-row run. They are counted, not named.
 */
function tryNormalizeEmail(raw: unknown): string | null {
  try {
    return normalizeContactEmail(raw);
  } catch {
    return null;
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Do two projections differ in any field the Contact row stores? */
function projectionDiffers(row: {
  name: string | null; kind: string; jobTitle: string | null;
  department: string | null; phone: string | null; description: string | null; origin: string;
}, next: ProjectedContact): boolean {
  return row.name !== next.name
    || row.kind !== next.kind
    || row.jobTitle !== next.jobTitle
    || row.department !== next.department
    || row.phone !== next.phone
    || row.description !== next.description
    || row.origin !== next.origin;
}

export interface RunDirectorySyncOptions {
  integrationId: string;
  integrationName: string;
  integrationType: "entraid" | "activedirectory";
  config: Record<string, unknown>;
  actor: string;
  signal?: AbortSignal;
}

/**
 * One sync pass for one integration. Provenance-bounded: it creates, refreshes
 * and removes only rows it can prove it owns.
 *
 * Cost is bounded by CHANGES, not by directory size — a steady-state run issues
 * zero writes, because the diff compares the stored `observed` blob and skips
 * anything identical. That is the `NotificationRuleState` "writes only on
 * transition" idiom, and it is what makes a 20,000-person directory affordable
 * on every discovery cycle.
 */
export async function runDirectorySync(opts: RunDirectorySyncOptions): Promise<DirectorySyncSummary> {
  const started = Date.now();
  const { integrationId, integrationName, integrationType, actor, signal } = opts;
  const filter = normalizeDirectorySyncFilter((opts.config as any)?.directorySync);
  const sourceKind = integrationType === "entraid" ? "entra" : "ad";
  const summary: DirectorySyncSummary = { ...EMPTY_SUMMARY };

  // ── 1. Read upstream ──────────────────────────────────────────────────────
  const entries = integrationType === "entraid"
    ? await listDirectoryPeopleEntra(opts.config as never, filter, signal)
    : await listDirectoryPeopleAd(opts.config as never, filter, signal);
  summary.scanned = entries.length;
  summary.capped = entries.length >= filter.maxEntries;

  // ── 2. Exclude, counting by category ──────────────────────────────────────
  const reasonCounts = new Map<string, number>();
  const kept: DirectoryPerson[] = [];
  for (const e of entries) {
    const reason = directoryExclusionReason(e, filter);
    if (reason) {
      summary.excluded++;
      reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
      continue;
    }
    kept.push(e);
  }
  summary.topExclusionReason =
    [...reasonCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  // ── 3. Normalize addresses, de-duping within the run ──────────────────────
  // A directory can carry two objects for one address (a user and a contact
  // object). First wins: a second provenance row for the same contact from the
  // same integration would be a stable duplicate nothing ever reconciles.
  const desired = new Map<string, { entry: DirectoryPerson; email: string }>();
  const seenEmails = new Set<string>();
  for (const e of kept) {
    const email = tryNormalizeEmail(e.email);
    if (!email) { summary.invalidAddress++; continue; }
    if (seenEmails.has(email)) continue;
    seenEmails.add(email);
    desired.set(e.externalId, { entry: e, email });
  }

  // ── 4. Local state: three reads, none of them per-row ─────────────────────
  const [ownProvenance, manualContacts, users] = await Promise.all([
    prisma.directoryContactSource.findMany({
      where: { integrationId },
      select: { externalId: true, contactId: true, observed: true },
    }),
    // Business rule 35(b): an operator-curated row wins, and so does a Polaris
    // account — an SSO-provisioned colleague is already in the GAL, and minting
    // a second entry for them is the duplicate this exists to prevent.
    prisma.contact.findMany({ where: { origin: "manual" }, select: { email: true } }),
    prisma.user.findMany({ where: { email: { not: null } }, select: { email: true } }),
  ]);

  const claimedManual = new Set(manualContacts.map((c) => c.email.toLowerCase()));
  // User.email is nullable, non-unique and NOT normalized on write, so this
  // comparison has to lower-case both sides itself.
  const claimedUser = new Set(users.map((u) => (u.email ?? "").trim().toLowerCase()).filter(Boolean));

  for (const [externalId, d] of [...desired]) {
    if (claimedUser.has(d.email)) { summary.skippedUser++; desired.delete(externalId); continue; }
    if (claimedManual.has(d.email)) { summary.skippedManual++; desired.delete(externalId); }
  }

  const provByExternalId = new Map(ownProvenance.map((p) => [p.externalId, p]));
  const touchedContactIds = new Set<string>();

  // ── 5. Create the contacts that don't exist yet ───────────────────────────
  const desiredEmails = [...desired.values()].map((d) => d.email);
  const existingByEmail = new Map<string, { id: string; origin: string }>();
  for (const batch of chunk(desiredEmails, WRITE_CHUNK * 5)) {
    const rows = await prisma.contact.findMany({
      where: { email: { in: batch } },
      select: { id: true, email: true, origin: true },
    });
    for (const r of rows) existingByEmail.set(r.email, { id: r.id, origin: r.origin });
  }

  const toCreate = [...desired.values()].filter((d) => !existingByEmail.has(d.email));
  for (const batch of chunk(toCreate, WRITE_CHUNK)) {
    // skipDuplicates covers the race with a concurrent operator create; the
    // re-read below then finds whichever row won.
    const createdBatch = await prisma.contact.createMany({
      data: batch.map((d) => ({
        email: d.email,
        // Through the PROJECTION rather than straight off the entry, even
        // though there is only one source here. The projection trims, so
        // writing the raw value would create the row and then immediately
        // update it in the same run for any directory value carrying stray
        // whitespace — a wasted write, and a summary that counts one person
        // as both created and updated. One definition of what a contact's
        // fields ARE, used by both writers.
        ...projectContactFromSources([{ sourceKind, observed: d.entry }]),
        // NULL, deliberately: a synced row is nobody's, which is also what makes
        // assertOwnership require fullwrite to edit or adopt one.
        createdBy: null,
      })),
      skipDuplicates: true,
    });
    // The RESULT count, not the batch size: skipDuplicates means a race with
    // a concurrent operator create silently drops a row, and reporting it as
    // created would make the summary disagree with the table.
    summary.created += createdBatch?.count ?? batch.length;
    const rows = await prisma.contact.findMany({
      where: { email: { in: batch.map((d) => d.email) } },
      select: { id: true, email: true, origin: true },
    });
    for (const r of rows) existingByEmail.set(r.email, { id: r.id, origin: r.origin });
  }

  // ── 6. Provenance: write only what changed ───────────────────────────────
  const provenanceCreates: { integrationId: string; externalId: string; sourceKind: string; contactId: string; observed: any }[] = [];
  const provenanceUpdates: { externalId: string; contactId: string; observed: any }[] = [];

  for (const [externalId, d] of desired) {
    const contact = existingByEmail.get(d.email);
    if (!contact) continue; // create raced and lost; next run picks it up
    touchedContactIds.add(contact.id);
    const prior = provByExternalId.get(externalId);
    if (!prior) {
      provenanceCreates.push({ integrationId, externalId, sourceKind, contactId: contact.id, observed: d.entry });
    } else if (
      prior.contactId !== contact.id ||
      JSON.stringify(prior.observed) !== JSON.stringify(d.entry)
    ) {
      // The address moved to a different contact, or the directory changed
      // something. Anything else is a no-op: comparing the blob is what keeps a
      // steady-state run at zero writes.
      provenanceUpdates.push({ externalId, contactId: contact.id, observed: d.entry });
    }
  }

  for (const batch of chunk(provenanceCreates, WRITE_CHUNK)) {
    await prisma.directoryContactSource.createMany({ data: batch as never, skipDuplicates: true });
  }
  for (const batch of chunk(provenanceUpdates, WRITE_CHUNK)) {
    await prisma.$transaction(batch.map((u) => prisma.directoryContactSource.update({
      where: { integrationId_externalId: { integrationId, externalId: u.externalId } },
      data: { contactId: u.contactId, observed: u.observed as never, lastSeenAt: new Date() },
    })));
  }

  // ── 7. Deletion, behind the guard ────────────────────────────────────────
  const goneExternalIds = ownProvenance
    .filter((p) => !desired.has(p.externalId))
    .map((p) => p.externalId);

  if (goneExternalIds.length > 0) {
    if (summary.scanned === 0 || deleteExceedsGuard(goneExternalIds.length, ownProvenance.length)) {
      // An empty or catastrophically-shrunken read is ambiguous, and the two
      // readings want opposite handling. Refuse the whole deletion half rather
      // than empty the address book on a revoked grant.
      summary.deleteSkippedGuard = true;
    } else {
      const orphanCandidates = new Set(
        ownProvenance.filter((p) => !desired.has(p.externalId)).map((p) => p.contactId),
      );
      for (const batch of chunk(goneExternalIds, WRITE_CHUNK)) {
        await prisma.directoryContactSource.deleteMany({
          where: { integrationId, externalId: { in: batch } },
        });
      }
      // A contact keeps living while ANY provenance row still claims it — the
      // other directory's, typically. `directorySources: { none: {} }` is what
      // makes that true without a second query, and `origin: { not: "manual" }`
      // makes deleting an adopted row structurally impossible even on a bug.
      for (const batch of chunk([...orphanCandidates], WRITE_CHUNK)) {
        const res = await prisma.contact.deleteMany({
          where: { id: { in: batch }, origin: { not: "manual" }, directorySources: { none: {} } },
        });
        summary.deleted += res.count;
      }
      for (const id of orphanCandidates) touchedContactIds.add(id);
    }
  }

  // ── 8. Re-project every touched contact from its FULL source set ─────────
  const touched = [...touchedContactIds];
  for (const batch of chunk(touched, WRITE_CHUNK)) {
    const rows = await prisma.contact.findMany({
      where: { id: { in: batch }, origin: { not: "manual" } },
      select: {
        id: true, name: true, kind: true, jobTitle: true, department: true,
        phone: true, description: true, origin: true,
        directorySources: { select: { sourceKind: true, observed: true } },
      },
    });
    const updates = [];
    for (const row of rows) {
      if (row.directorySources.length === 0) continue; // deleted, or about to be
      const next = projectContactFromSources(
        row.directorySources.map((sv) => ({ sourceKind: sv.sourceKind, observed: sv.observed as unknown as DirectoryPerson })),
      );
      if (!projectionDiffers(row, next)) { summary.unchanged++; continue; }
      updates.push(prisma.contact.update({ where: { id: row.id }, data: next }));
      summary.updated++;
    }
    if (updates.length) await prisma.$transaction(updates);
  }

  bumpContactCache();
  summary.tookMs = Date.now() - started;

  const changed = summary.created + summary.updated + summary.deleted;
  await logEvent({
    action: "integration.directory_sync",
    resourceType: "integration",
    resourceId: integrationId,
    resourceName: integrationName,
    actor,
    level: summary.deleteSkippedGuard || summary.capped ? "warning" : "info",
    message:
      `Directory sync for "${integrationName}" — scanned ${summary.scanned}, ` +
      `${summary.created} added, ${summary.updated} updated, ${summary.deleted} removed, ` +
      `${summary.excluded} excluded${summary.topExclusionReason ? ` (mostly: ${summary.topExclusionReason})` : ""}` +
      `${summary.deleteSkippedGuard ? " — REMOVALS SKIPPED: the directory returned far fewer entries than expected" : ""}` +
      `${summary.capped ? ` — hit the ${filter.maxEntries} entry cap; raise it or narrow the filter` : ""}`,
    // COUNTS ONLY. No address, name, title, department, phone, DN or object id
    // may appear here: Event.details is readable by anyone with events access
    // and is shipped off-host by the syslog and SFTP archivers.
    details: { ...summary, changed },
  });

  return summary;
}

/**
 * Drop everything one integration's sync owns: its provenance rows, and every
 * contact left with none.
 *
 * Called when the toggle is switched off, when the integration is disabled, and
 * before an integration is deleted — the last of which is why there is no FK on
 * `integrationId`. Without this the rows would outlive the thing that explains
 * them, and an operator would be left with an employee roster in their address
 * book that nothing can refresh and nothing will ever remove.
 */
export async function purgeDirectoryContacts(
  integrationId: string,
  reason: string,
  actor?: string,
): Promise<number> {
  const owned = await prisma.directoryContactSource.findMany({
    where: { integrationId },
    select: { contactId: true },
  });
  if (owned.length === 0) return 0;

  const contactIds = [...new Set(owned.map((o) => o.contactId))];
  await prisma.directoryContactSource.deleteMany({ where: { integrationId } });

  let deleted = 0;
  for (const batch of chunk(contactIds, WRITE_CHUNK)) {
    const res = await prisma.contact.deleteMany({
      where: { id: { in: batch }, origin: { not: "manual" }, directorySources: { none: {} } },
    });
    deleted += res.count;
  }

  bumpContactCache();
  await logEvent({
    action: "contact.directory_sync.purged",
    resourceType: "integration",
    resourceId: integrationId,
    actor,
    level: "warning",
    message: `Removed ${deleted} directory-synced address-book entr${deleted === 1 ? "y" : "ies"} — ${reason}`,
    details: { deleted, provenanceRows: owned.length, reason },
  });
  return deleted;
}

/**
 * True when at least one enabled integration has the sync switched on.
 *
 * Delegates to the directory enumeration in directorySearchService rather than
 * repeating the query: the address book's source tabs read the same rows to
 * decide which directories to offer, and two copies of "what counts as a
 * directory" is how a newly supported backend gets tabs but no sync flag.
 */
export async function directorySyncAvailable(): Promise<boolean> {
  return (await listDirectorySources()).some((s) => s.sync);
}
