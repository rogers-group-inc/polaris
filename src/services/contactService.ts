/**
 * src/services/contactService.ts
 *
 * The address book: named email addresses alerts can route to, each optionally
 * owning a set of devices.
 *
 * Two distinct jobs, which is why this is a table rather than a free-text field:
 *
 *   1. A durable label for an address that has no Polaris account behind it —
 *      a distribution list, an on-call rotation, a vendor NOC. Before this,
 *      such an address could only be retyped into every automation.
 *   2. Device ownership. `assetCondition` — the SAME nested AND/OR condition
 *      tree the automations device filter uses — unioned with explicit
 *      `assetIds` pins says which devices a contact is responsible for. A notify
 *      action carrying `recipientAssetContacts` resolves that at fire time, so
 *      "email whoever owns this box" needs no per-rule recipient list.
 *
 * FILTER SHAPE. `assetCondition` superseded the flat `assetCriteria`
 * (tagAssignmentService vocabulary) so operators are not asked "which devices?"
 * in two different languages. Both columns are still READ — a row written before
 * the cutover keeps matching through the legacy predicate until it folds forward
 * — but only one is ever live on a row: a write of the condition nulls the
 * criteria. Readers go through `contactFilterOf`, and `criteriaToCondition` is
 * the fold-forward (persisted by the migrateContactFilterShape one-shot, the
 * migrateAutomationRuleShape precedent).
 *
 * Fire-time matching (`resolveContactsForAsset`) evaluates each contact's filter
 * against the ONE triggering asset — the pure `evaluateScopeCondition` for a
 * tree, `assetMatchesCriteria` for a legacy blob — never a fleet scan. Cost is
 * bounded by contact count, not asset count, and the contact list itself rides a
 * short-TTL cache so a delivery expansion doesn't re-read the table per alert.
 *
 * Ownership: `createdBy` backs the `contacts` function key's ownership
 * dimension (write = your own rows, fullwrite = anyone's), the same mechanism
 * subnets and reservations use. Routes call assertOwnership; this service
 * stays level-agnostic apart from stamping createdBy on create.
 */

import { prisma } from "../db.js";
import { Prisma } from "../generated/prisma/client.js";
import { AppError } from "../utils/errors.js";
import { createTtlCache } from "../utils/ttlCache.js";
import {
  assetMatchesCriteria,
  cidrsContainingIp,
  collectCidrs,
  normalizeCriteria,
  resolveMatchingAssetIds,
  SINGLE_ASSET_CANDIDATE_SELECT,
  type TagCriteria,
} from "./tagAssignmentService.js";
import {
  deviceFilterConditionSchema,
  conditionNeedsApVaps,
  conditionNeedsInterfaces,
  evaluateScopeCondition,
  scopeConditionStats,
  SCOPE_CONDITION_MAX_DEPTH,
  SCOPE_CONDITION_MAX_RULES,
  type ScopeConditionAsset,
  type ScopeConditionGroup,
} from "./notificationTypes.js";
import { resolveDeviceFilterAssetIds } from "./deviceFilterService.js";
import { criteriaToCondition } from "../utils/criteriaToCondition.js";
import { listRecipientUsers } from "./notificationRecipientService.js";
import { logEvent } from "./eventLogService.js";
import { logger } from "../utils/logger.js";
import { MIN_DIRECTORY_QUERY, searchDirectory, type DirectorySourceKind } from "./directorySearchService.js";

// ─── Types ──────────────────────────────────────────────────────────────────

/** Who owns a contact row. See business rule 35. */
export type ContactOrigin = "manual" | "entra" | "ad";

/** A synced row is one the directory sync created and still claims. */
export function isDirectoryOrigin(origin: string): boolean {
  return origin !== "manual";
}

export interface ContactRow {
  id: string;
  email: string;
  name: string | null;
  description: string | null;
  /**
   * "manual" for anything an operator created, otherwise the directory that
   * did. Drives the visibility gate, the adoption path, and what the picker
   * badges -- the backend names line up with AddressBookEntry.source on purpose.
   */
  origin: string;
  kind: string;
  jobTitle: string | null;
  department: string | null;
  phone: string | null;
  /** The live filter shape. */
  assetCondition: ScopeConditionGroup | null;
  /** Legacy flat filter — null on any row written since the cutover. */
  assetCriteria: TagCriteria | null;
  /**
   * DERIVED, read-only: the filter as a tree whatever it is stored as, so the
   * editor renders one shape and a legacy row still opens in the new builder.
   */
  assetConditionEffective: ScopeConditionGroup | null;
  /**
   * DERIVED, read-only: fields in a legacy blob the tree can't express. Non-empty
   * means the builder cannot SHOW this row's filter — the editor warns and posts
   * the blob back untouched rather than replacing it with an empty tree.
   */
  assetFilterUnconvertible: string[];
  assetIds: string[];
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ContactInput {
  email: string;
  name?: string | null;
  description?: string | null;
  /**
   * Operator-settable on a manual row. On a SYNCED row these are projected
   * from the directory and an operator write would be overwritten on the next
   * run -- which is why editing a synced row adopts it (see adoptDirectoryContact).
   */
  jobTitle?: string | null;
  department?: string | null;
  phone?: string | null;
  assetCondition?: unknown;
  /**
   * Accepted so an API caller (and the pre-cutover UI) can still post a flat
   * blob. It is folded forward to a condition on write when the tree can say
   * everything it says, and stored as legacy criteria only when it can't (an
   * `integration` rule) — never silently narrowed.
   */
  assetCriteria?: unknown;
  /**
   * "Responsible for EVERY device." Its own boolean rather than an empty
   * condition group: `and([])` is true by boolean identity, so a malformed or
   * half-built tree arriving empty would quietly make a contact own the whole
   * fleet and take every alert. An explicit flag is the only way in; anything
   * empty normalizes to "owns nothing", which is the safe reading and the state
   * every address-only contact is in.
   */
  assetAllDevices?: boolean;
  assetIds?: string[];
}

/** Just the device-ownership half — what the preview dry-run posts. */
export type ContactFilterInput = Pick<
  ContactInput,
  "assetCondition" | "assetCriteria" | "assetAllDevices" | "assetIds"
>;

/**
 * One row in the unified address-book search. `source` says where the entry
 * came from so the picker can badge it; the directory sources (entra / ad) are
 * filled in by directorySearchService and never persisted.
 */
export interface AddressBookEntry {
  source: "user" | "contact" | "entra" | "ad";
  id: string;
  email: string;
  name: string | null;
  description: string | null;
  kind: "person" | "group";
  /** True when the caller may edit/delete this entry (contacts only). */
  owned?: boolean;
  /**
   * Two people called "J. Martin" are told apart by their job, not their id,
   * so the picker needs these to be pickable at all. Present on stored
   * contacts and on live directory hits; absent on Polaris user accounts,
   * which have no such fields.
   */
  jobTitle?: string | null;
  department?: string | null;
  phone?: string | null;
  /** Provenance of a stored contact -- "manual" unless the sync owns it. */
  origin?: string;
  /**
   * How many browsers this ACCOUNT has enrolled for Web Push. Present on
   * `source: "user"` entries only -- a contact or a directory hit is an
   * address, and an address is not a push endpoint.
   *
   * Rides this payload because `listRecipientUsers` already computes it (one
   * groupBy it used to discard here), and because zero is the single most
   * common reason a push automation is configured correctly and delivers
   * nothing -- the same fact the wizard's push picker warns about, on the page
   * that lists who Polaris can reach.
   */
  pushDevices?: number;
}

const MAX_ASSET_PINS = 500;

// ─── Normalization ──────────────────────────────────────────────────────────

/**
 * Addresses are compared case-insensitively everywhere downstream
 * (resolveEmailRecipients lower-cases before deduping), so the table stores the
 * lower-cased form and the unique index enforces case-insensitive uniqueness
 * for free.
 */
export function normalizeContactEmail(raw: unknown): string {
  const email = String(raw ?? "").trim().toLowerCase();
  if (!email) throw new AppError(400, "Email address is required");
  if (email.length > 320) throw new AppError(400, "Email address is too long (max 320 characters)");
  // Deliberately permissive — the same shape Zod's .email() accepts, without
  // pulling Zod into a service. A directory can hand back addresses that a
  // stricter RFC parser would reject.
  if (!/^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(email)) {
    throw new AppError(400, `"${email}" is not a valid email address`);
  }
  return email;
}

function trimOrNull(raw: unknown): string | null {
  const v = String(raw ?? "").trim();
  return v ? v : null;
}

/**
 * "Owns every device" — the stored form of the editor's All-devices checkbox.
 * `and([])` is true for any asset by boolean identity, which is exactly the
 * semantics wanted; see ContactInput.assetAllDevices for why nothing else may
 * produce it.
 */
const ALL_DEVICES_CONDITION: ScopeConditionGroup = { op: "and", children: [] };

/** Does this stored condition mean "every device"? */
export function conditionMeansAllDevices(cond: ScopeConditionGroup | null): boolean {
  return !!cond && cond.op === "and" && cond.children.length === 0;
}

/**
 * Validate a posted condition tree against the DEVICE_FILTER vocabulary (the
 * automations scope fields plus the four the flat builder carried). An empty
 * tree is "no filter", never "all devices".
 */
export function normalizeContactCondition(raw: unknown): ScopeConditionGroup | null {
  if (raw == null) return null;
  const parsed = deviceFilterConditionSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new AppError(400, `Device filter is invalid${first ? `: ${first.message}` : ""}`);
  }
  const cond = parsed.data;
  const { depth, rules } = scopeConditionStats(cond);
  if (depth > SCOPE_CONDITION_MAX_DEPTH) {
    throw new AppError(400, `Device filter groups nest at most ${SCOPE_CONDITION_MAX_DEPTH} deep`);
  }
  if (rules > SCOPE_CONDITION_MAX_RULES) {
    throw new AppError(400, `At most ${SCOPE_CONDITION_MAX_RULES} conditions per device filter`);
  }
  return rules === 0 ? null : cond;
}

/**
 * The ONE filter a contact row matches by. A stored condition wins; otherwise a
 * legacy flat criteria blob is folded forward on the fly, so every consumer sees
 * a tree whether or not the row has been rewritten yet — and a criteria blob the
 * tree can't express (an `integration` rule) keeps matching through the flat
 * predicate instead of being half-converted.
 */
export function contactFilterOf(
  contact: Pick<ContactRow, "assetCondition" | "assetCriteria">,
): { condition: ScopeConditionGroup | null; criteria: TagCriteria | null } {
  if (contact.assetCondition) return { condition: contact.assetCondition, criteria: null };
  if (!contact.assetCriteria) return { condition: null, criteria: null };
  const { condition, unconvertible } = criteriaToCondition(contact.assetCriteria);
  return unconvertible.length > 0
    ? { condition: null, criteria: contact.assetCriteria }
    : { condition: condition as ScopeConditionGroup | null, criteria: null };
}

function normalizeAssetIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out = Array.from(
    new Set(raw.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim())),
  );
  if (out.length > MAX_ASSET_PINS) {
    throw new AppError(400, `Too many pinned devices (max ${MAX_ASSET_PINS})`);
  }
  return out;
}

function rowToContact(row: {
  id: string;
  email: string;
  name: string | null;
  description: string | null;
  origin: string;
  kind: string;
  jobTitle: string | null;
  department: string | null;
  phone: string | null;
  assetCondition: unknown;
  assetCriteria: unknown;
  assetIds: string[];
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}): ContactRow {
  const assetCondition = safeStoredCondition(row.assetCondition, row.id);
  const assetCriteria = normalizeCriteria(row.assetCriteria);
  const folded = assetCondition ? null : criteriaToCondition(assetCriteria);
  return {
    ...row,
    // Stored blobs are re-normalized on read rather than trusted: a shape
    // written before a vocabulary change would otherwise reach the matcher
    // unvalidated. A stored condition that no longer validates is dropped to
    // null rather than throwing — one bad row must not 500 the whole list.
    assetCondition,
    assetCriteria,
    // A blob that can't be represented reports NO effective tree, so the editor
    // can't mistake "we couldn't convert it" for "there is no filter".
    assetConditionEffective:
      assetCondition ?? (folded && folded.unconvertible.length === 0 ? (folded.condition as ScopeConditionGroup | null) : null),
    assetFilterUnconvertible: folded?.unconvertible ?? [],
  };
}

function safeStoredCondition(raw: unknown, contactId: string): ScopeConditionGroup | null {
  if (raw == null) return null;
  // The all-devices marker has zero rules, so normalizeContactCondition would
  // read it as "no filter" — it's the one empty tree that means something.
  if (conditionMeansAllDevices(raw as ScopeConditionGroup)) return ALL_DEVICES_CONDITION;
  try {
    return normalizeContactCondition(raw);
  } catch (err) {
    logger.warn({ err, contactId }, "Stored contact device filter is invalid; treating as no filter");
    return null;
  }
}

/**
 * Resolve what a write should store for the two filter columns. Exactly one is
 * live: a condition (or the folded-forward form of a posted flat blob) nulls the
 * criteria, and a blob carrying a rule the tree can't express stays flat.
 */
function resolveWrittenFilter(input: ContactFilterInput): {
  condition: ScopeConditionGroup | null;
  criteria: TagCriteria | null;
} {
  if (input.assetAllDevices) return { condition: ALL_DEVICES_CONDITION, criteria: null };

  const condition = normalizeContactCondition(input.assetCondition ?? null);
  if (condition) return { condition, criteria: null };

  // No tree posted — accept a flat blob and fold it forward where possible.
  const criteria = normalizeCriteria(input.assetCriteria ?? null);
  if (!criteria) return { condition: null, criteria: null };
  const folded = criteriaToCondition(criteria);
  return folded.unconvertible.length === 0 && folded.condition
    ? { condition: folded.condition as ScopeConditionGroup, criteria: null }
    : { condition: null, criteria };
}

// ─── Cache ──────────────────────────────────────────────────────────────────

// Fire-time resolution reads the contact table on each alert; without this the
// delivery expansion would re-read it per notification. 30s mirrors the
// recipient user index next door.
const CONTACT_CACHE_TTL_MS = 30_000;
const _contactCache = createTtlCache<ContactRow[]>({ ttlMs: CONTACT_CACHE_TTL_MS, maxEntries: 1 });

/** Drop the cached contact list (called after every contact write). */
export function bumpContactCache(): void {
  _contactCache.invalidate();
}

/**
 * The only contacts `resolveContactsForAsset` can possibly return: those
 * carrying a device filter (a condition tree or a legacy criteria blob) or at
 * least one explicit pin.
 *
 * The narrowing is a correctness-preserving bound, not a micro-optimization. A
 * contact with no filter and no pins owns no devices, so it can never match a
 * triggering asset -- loading it costs a row, a JSON parse and a
 * criteriaToCondition fold to reach a foregone conclusion. That was invisible
 * while the address book was hand-curated and tens of rows deep. It stops being
 * invisible the moment a bulk source can put thousands of address-only rows in
 * the table, at which point the alert fire path would scale with the size of the
 * company rather than with the number of people who actually own equipment.
 *
 * `assetIds: { isEmpty: false }` covers the pin case; the two JSON columns are
 * DB-NULL (not JSON-null) on an unfiltered row, because the writers pass
 * `undefined` rather than a null literal.
 */
function loadFilterCarryingContacts(): Promise<ContactRow[]> {
  return _contactCache.getOrCompute("", async () => {
    const rows = await prisma.contact.findMany({
      where: {
        OR: [
          { assetCondition: { not: Prisma.DbNull } },
          { assetCriteria: { not: Prisma.DbNull } },
          { assetIds: { isEmpty: false } },
        ],
      },
      orderBy: { email: "asc" },
    });
    return rows.map(rowToContact);
  });
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

/** One page of the address book, plus the unpaged total the pager needs. */
export interface ContactPage {
  contacts: ContactRow[];
  /** Rows matching the query across ALL pages -- not `contacts.length`. */
  total: number;
}

export interface ListContactsOptions {
  /** Substring match on email or name, case-insensitive. Blank = everything. */
  q?: string | null;
  limit?: number;
  offset?: number;
  /**
   * "manual" = curated only, "directory" = synced only, "all" = both, or a
   * single backend ("entra" / "ad") for the rows THAT directory produced —
   * which is what the address book's per-directory tab asks for. A specific
   * backend is a narrowing of "directory" and takes the same visibility gate.
   */
  origin?: "manual" | "directory" | "all" | DirectorySourceKind;
  /**
   * FALSE hides every directory-synced row, whatever `origin` asks for.
   *
   * This is the visibility gate, and it is deliberately a separate parameter
   * from `origin` so a caller cannot widen its own access by passing a filter:
   * the route derives this from the caller's permissions and the operator picks
   * `origin`. A gated caller asking for `origin: "directory"` gets an empty
   * page rather than a 403 -- the filter-don't-403 posture the other
   * mixed-visibility endpoints use.
   */
  includeDirectorySynced?: boolean;
}

export const CONTACT_PAGE_DEFAULT = 50;
export const CONTACT_PAGE_MAX = 200;

/**
 * The shared substring predicate. `mode: "insensitive"` compiles to ILIKE, which
 * the trigram indexes on `lower(email)` / `lower(name)` serve -- without them
 * this is a sequential scan, and paginating would bound the payload without
 * bounding the work.
 */
/**
 * The origin half of the predicate: what the caller ASKED for, intersected
 * with what they are ALLOWED to see. The gate always wins, and the result is
 * an empty page rather than a 403 -- the filter-don't-403 posture.
 *
 * The intersection is the subtle part. A caller who may not see synced rows and
 * asks for ONLY synced rows must get NOTHING: falling back to the manual rows
 * would answer a question they did not ask, and a table full of unexpected rows
 * reads as "the filter is broken", not as "you may not see those".
 */
function contactOriginWhere(opts: ListContactsOptions) {
  const maySeeSynced = opts.includeDirectorySynced === true;
  const wants = opts.origin ?? "all";

  if (wants === "manual") return { origin: "manual" };
  if (wants === "directory") {
    // `in: []` matches nothing, which is the honest answer to "the synced rows,
    // please" from someone who may not have them.
    return maySeeSynced ? { origin: { not: "manual" } } : { origin: { in: [] as string[] } };
  }
  // One named backend — the same answer, narrowed to the rows it owns.
  if (wants !== "all") {
    return maySeeSynced ? { origin: wants } : { origin: { in: [] as string[] } };
  }
  return maySeeSynced ? {} : { origin: "manual" };
}

function contactSearchWhere(q: string) {
  if (!q) return {};
  return {
    OR: [
      { email: { contains: q, mode: "insensitive" as const } },
      { name: { contains: q, mode: "insensitive" as const } },
    ],
  };
}

/**
 * One page of the address book, filtered SERVER-side.
 *
 * Both halves used to be the caller's problem: this returned every row and the
 * browser filtered in JavaScript. That is fine for a curated list and untenable
 * for a table a bulk source can grow without bound -- the payload carries two
 * JSON blobs per row and `rowToContact` re-validates both, so the cost of
 * "show me the address book" grew with the whole table, on every keystroke.
 */
export async function listContacts(opts: ListContactsOptions = {}): Promise<ContactPage> {
  const q = String(opts.q ?? "").trim();
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? CONTACT_PAGE_DEFAULT), 1), CONTACT_PAGE_MAX);
  const offset = Math.max(Math.trunc(opts.offset ?? 0), 0);
  const where = { ...contactSearchWhere(q), ...contactOriginWhere(opts) };

  const [rows, total] = await Promise.all([
    prisma.contact.findMany({
      where,
      orderBy: [{ name: "asc" }, { email: "asc" }],
      take: limit,
      skip: offset,
    }),
    prisma.contact.count({ where }),
  ]);
  return { contacts: rows.map(rowToContact), total };
}

export async function getContact(id: string): Promise<ContactRow | null> {
  const row = await prisma.contact.findUnique({ where: { id } });
  return row ? rowToContact(row) : null;
}


/**
 * Take a directory-synced row out of the sync's hands and make it the
 * operator's: `origin` back to "manual", `createdBy` stamped, provenance rows
 * deleted.
 *
 * Dropping the provenance is the whole mechanism, not bookkeeping. The sync
 * deletes a row when its LAST DirectoryContactSource goes; a row with none was
 * never the sync's to delete. So adoption is exactly what makes the row survive
 * the person leaving the directory -- and what stops the next run re-creating a
 * second entry for an address it no longer recognizes as its own.
 *
 * The Event NAMES the address, unlike the sync's own counts-only Events. That
 * asymmetry is deliberate: this is a single deliberate act by a person, audited
 * the same way `contact.created` and `contact.updated` already are, whereas bulk
 * machine activity must not put the employee roster into `Event.details`.
 */
export async function adoptDirectoryContact(
  id: string,
  opts: { input?: ContactInput; actor?: string | null; reason?: string } = {},
): Promise<ContactRow> {
  const before = await prisma.contact.findUnique({
    where: { id },
    select: { id: true, email: true, name: true, origin: true },
  });
  if (!before) throw new AppError(404, "Contact not found");
  if (!isDirectoryOrigin(before.origin)) {
    throw new AppError(409, `"${before.email}" is already an address-book entry you own`);
  }

  const input = opts.input;
  const filter = input ? resolveWrittenFilter(input) : null;
  const assetIds = input ? normalizeAssetIds(input.assetIds) : undefined;

  // One transaction: a row promoted to "manual" while its provenance survived
  // would be re-adopted on every run, and provenance deleted while the row
  // stayed "entra" would be a synced row no sync can ever clean up.
  const [, row] = await prisma.$transaction([
    prisma.directoryContactSource.deleteMany({ where: { contactId: id } }),
    prisma.contact.update({
      where: { id },
      data: {
        origin: "manual",
        createdBy: opts.actor ?? null,
        // Only when the caller supplied values. A bare adopt (the Adopt button)
        // keeps everything the directory last reported -- the point is to take
        // ownership of the entry, not to blank it.
        ...(input
          ? {
              email: normalizeContactEmail(input.email),
              name: trimOrNull(input.name),
              description: trimOrNull(input.description),
              jobTitle: trimOrNull(input.jobTitle),
              department: trimOrNull(input.department),
              phone: trimOrNull(input.phone),
              assetCondition: (filter!.condition ?? null) as never,
              assetCriteria: (filter!.criteria ?? null) as never,
              assetIds,
            }
          : {}),
      },
    }),
  ]);

  bumpContactCache();
  await logEvent({
    action: "contact.adopted",
    resourceType: "contact",
    resourceId: row.id,
    resourceName: row.email,
    actor: opts.actor ?? undefined,
    message:
      `Took ownership of ${row.name ? `"${row.name}" <${row.email}>` : row.email}, previously synced from ` +
      `${before.origin === "ad" ? "Active Directory" : "Entra ID"}` +
      `${opts.reason ? ` (${opts.reason})` : ""}. It will no longer be updated or removed by the directory sync.`,
    details: { previousOrigin: before.origin },
  });
  return rowToContact(row);
}

export async function createContact(input: ContactInput, createdBy: string | null): Promise<ContactRow> {
  const email = normalizeContactEmail(input.email);
  const { condition: assetCondition, criteria: assetCriteria } = resolveWrittenFilter(input);
  const assetIds = normalizeAssetIds(input.assetIds);

  const existing = await prisma.contact.findUnique({
    where: { email },
    select: { id: true, name: true, origin: true },
  });
  if (existing && isDirectoryOrigin(existing.origin)) {
    // The address is held by a row the directory sync created. `email` is
    // UNIQUE, so a synced row physically blocks hand-creating the same person
    // -- and refusing here would leave an operator no way to take ownership of
    // an address they are looking straight at.
    //
    // Adopting is also what PRESERVES the sync's own guarantee. A departed
    // person's row is deleted on the next run (business rule 35); a row an
    // operator has claimed must survive that, and the way the reconcile knows
    // to leave it alone is that adoption drops its provenance.
    return adoptDirectoryContact(existing.id, {
      input,
      actor: createdBy,
      reason: "created over a directory-synced address",
    });
  }
  if (existing) {
    throw new AppError(409, `"${email}" is already in the address book${existing.name ? ` as "${existing.name}"` : ""}`);
  }

  const row = await prisma.contact.create({
    data: {
      email,
      name: trimOrNull(input.name),
      description: trimOrNull(input.description),
      jobTitle: trimOrNull(input.jobTitle),
      department: trimOrNull(input.department),
      phone: trimOrNull(input.phone),
      assetCondition: (assetCondition ?? undefined) as never,
      assetCriteria: (assetCriteria ?? undefined) as never,
      assetIds,
      createdBy,
    },
  });
  bumpContactCache();
  await logEvent({
    action: "contact.created",
    resourceType: "contact",
    resourceId: row.id,
    resourceName: row.email,
    actor: createdBy ?? undefined,
    message: `Added ${row.name ? `"${row.name}" <${row.email}>` : row.email} to the address book${describeTargets(assetCondition, assetCriteria, assetIds)}`,
  });
  return rowToContact(row);
}

/** " (device ownership: 3 conditions + 2 pinned devices)" — "" when untargeted. */
function describeTargets(
  condition: ScopeConditionGroup | null,
  criteria: TagCriteria | null,
  assetIds: string[],
): string {
  const parts: string[] = [];
  if (conditionMeansAllDevices(condition)) parts.push("all devices");
  else if (condition) {
    const { rules } = scopeConditionStats(condition);
    parts.push(`${rules} condition${rules === 1 ? "" : "s"}`);
  } else if (criteria) {
    parts.push(`${criteria.rules.length} legacy filter rule${criteria.rules.length === 1 ? "" : "s"}`);
  }
  if (assetIds.length) parts.push(`${assetIds.length} pinned device${assetIds.length === 1 ? "" : "s"}`);
  return parts.length ? ` (device ownership: ${parts.join(" + ")})` : "";
}

export async function updateContact(id: string, input: ContactInput, actor?: string): Promise<ContactRow> {
  const email = normalizeContactEmail(input.email);
  const { condition: assetCondition, criteria: assetCriteria } = resolveWrittenFilter(input);
  const assetIds = normalizeAssetIds(input.assetIds);

  const clash = await prisma.contact.findUnique({ where: { email }, select: { id: true } });
  if (clash && clash.id !== id) {
    throw new AppError(409, `"${email}" is already in the address book`);
  }

  // Editing a synced row takes ownership of it. Writing the operator's values
  // into a row the sync still claims would look like it worked and then be
  // silently overwritten on the next discovery run.
  //
  // Reaching here on a synced row already requires `fullwrite`, with no code:
  // synced rows carry `createdBy = null`, and assertOwnership refuses a null
  // createdBy for a write-level caller. That is intentional, not an accident
  // to be tidied up -- taking a directory row out of the sync's hands is an
  // administrative act.
  const current = await prisma.contact.findUnique({ where: { id }, select: { origin: true } });
  if (!current) throw new AppError(404, "Contact not found");
  if (isDirectoryOrigin(current.origin)) {
    return adoptDirectoryContact(id, { input, actor: actor ?? null, reason: "edited a directory-synced entry" });
  }

  const row = await prisma.contact.update({
    where: { id },
    data: {
      email,
      name: trimOrNull(input.name),
      description: trimOrNull(input.description),
      jobTitle: trimOrNull(input.jobTitle),
      department: trimOrNull(input.department),
      phone: trimOrNull(input.phone),
      // Both nulls must be written explicitly — `undefined` would leave a stale
      // blob in place when the operator clears the filter, and leaving the
      // legacy column behind a new condition would resurrect the old filter on
      // any reader that checks criteria first.
      assetCondition: (assetCondition ?? null) as never,
      assetCriteria: (assetCriteria ?? null) as never,
      assetIds,
    },
  });
  bumpContactCache();
  await logEvent({
    action: "contact.updated",
    resourceType: "contact",
    resourceId: row.id,
    resourceName: row.email,
    actor,
    message: `Updated address-book entry ${row.name ? `"${row.name}" <${row.email}>` : row.email}${describeTargets(assetCondition, assetCriteria, assetIds)}`,
  });
  return rowToContact(row);
}

export async function deleteContact(id: string, actor?: string): Promise<void> {
  // Read first so the audit event can name what was removed — a bare id in the
  // log is useless once the row is gone.
  const existing = await prisma.contact.findUnique({
    where: { id },
    select: { email: true, name: true, origin: true },
  });
  if (existing && isDirectoryOrigin(existing.origin)) {
    // Deleting would succeed and then be undone by the next discovery run,
    // which is a worse outcome than refusing: the operator would believe the
    // address was gone. Name both real ways out instead.
    throw new AppError(
      409,
      `"${existing.email}" is synced from your ${existing.origin === "ad" ? "Active Directory" : "Entra ID"} ` +
      "integration and would return on the next discovery run. Exclude it in that integration's " +
      "directory-sync filter, or save it to the address book first to take ownership of it.",
    );
  }
  await prisma.contact.delete({ where: { id } });
  bumpContactCache();
  await logEvent({
    action: "contact.deleted",
    resourceType: "contact",
    resourceId: id,
    resourceName: existing?.email,
    actor,
    message: `Removed ${existing?.name ? `"${existing.name}" <${existing.email}>` : (existing?.email ?? id)} from the address book`,
  });
}

// ─── Asset targeting ────────────────────────────────────────────────────────

export interface ContactAssetPreview {
  /** MONITORED devices the filter covers — what the editor lists and counts. */
  matchCount: number;
  /**
   * Covered devices that are NOT monitored. Counted, never listed: the filter
   * genuinely selects them, so hiding them would understate who the contact is
   * on the hook for — but no automation fires about an unmonitored device
   * (assetCanTrigger), so they aren't what an operator picking a recipient is
   * choosing between, and they'd swamp the list on a fleet with a large
   * unmonitored inventory.
   */
  unmonitoredCount: number;
  sample: Array<{ id: string; hostname: string | null; ipAddress: string | null; assetType: string }>;
}

/**
 * Dry-run for the editor: which devices a (criteria, pins) pair covers right
 * now. Union of criteria matches and explicit pins — unlike MaintenanceSchedule
 * this is NOT intersected with monitored=true: an unmonitored device still has
 * an owner worth recording, and ownership is an address-book fact rather than
 * an alerting one. No automation currently fires about such a device, so the
 * two halves are reported separately and the caller decides what to say.
 */
export async function previewContactAssets(
  input: ContactFilterInput,
): Promise<ContactAssetPreview> {
  const { condition, criteria } = resolveWrittenFilter(input);
  const assetIds = normalizeAssetIds(input.assetIds);

  const union = new Set<string>(assetIds);
  if (condition) {
    for (const id of await resolveAssetIdsForCondition(condition)) union.add(id);
  } else if (criteria) {
    for (const id of await resolveMatchingAssetIds(criteria)) union.add(id);
  }
  if (union.size === 0) return { matchCount: 0, unmonitoredCount: 0, sample: [] };

  // One read for both halves: the count of monitored matches and the sample come
  // from the same rows, so they can't disagree.
  const rows = await prisma.asset.findMany({
    where: { id: { in: Array.from(union) } },
    select: { id: true, hostname: true, ipAddress: true, assetType: true, monitored: true },
    orderBy: { hostname: "asc" },
  });
  const monitored = rows.filter((r) => r.monitored);
  return {
    matchCount: monitored.length,
    unmonitoredCount: rows.length - monitored.length,
    sample: monitored.slice(0, 100).map(({ monitored: _m, ...rest }) => rest),
  };
}

/**
 * Which assets a condition tree covers right now — the editor's live preview.
 *
 * Delegates to the shared `resolveDeviceFilterAssetIds`: tags ask the identical
 * question of the identical tree, and the conditional relation joins behind it
 * are exactly the detail that must not exist in two copies.
 */
function resolveAssetIdsForCondition(cond: ScopeConditionGroup): Promise<Set<string>> {
  return resolveDeviceFilterAssetIds(cond);
}

/**
 * The contacts responsible for ONE asset — the fire-time path.
 *
 * Deliberately shaped to avoid a fleet scan: the asset is loaded once, and each
 * contact's criteria is tested against it in memory. Subnet rules need CIDR
 * containment, which is a single inet round-trip across every contact's CIDRs
 * combined (and skipped entirely when no contact filters by subnet — the common
 * case). Cost therefore scales with the number of CONTACTS, not with fleet size.
 *
 * Mirrors reconcileTagsForAsset, which does the same thing for managed tags.
 */
export async function resolveContactsForAsset(assetId: string): Promise<ContactRow[]> {
  const contacts = await loadFilterCarryingContacts();
  if (contacts.length === 0) return [];

  // Pinned-only contacts need no asset load at all.
  const byPin = contacts.filter((c) => c.assetIds.includes(assetId));
  const filtered = contacts
    .map((c) => ({ contact: c, ...contactFilterOf(c) }))
    .filter((f) => f.condition != null || f.criteria != null);
  if (filtered.length === 0) return byPin;

  // ONE asset, so the interface relation is joined here rather than resolved
  // through scopeInterfaceIndex — a second round trip would cost more than the
  // rows do. Conditional all the same: most fleets have no contact filtering by
  // interface, and this is the alert fan-out path.
  const needsInterfaces = filtered.some((f) => conditionNeedsInterfaces(f.condition));
  const needsApVaps = filtered.some((f) => conditionNeedsApVaps(f.condition));
  const asset = await prisma.asset.findUnique({
    where: { id: assetId },
    // `tags` on top of the flat-criteria select: the condition tree has a `tag`
    // field, which that vocabulary never had.
    select: {
      ...SINGLE_ASSET_CANDIDATE_SELECT,
      tags: true,
      ...(needsInterfaces ? { interfaces: { select: { ifName: true } } } : {}),
      ...(needsApVaps ? { apVaps: { select: { ssid: true } } } : {}),
    },
  });
  if (!asset) return byPin;

  // Only the LEGACY predicate needs the inet round-trip — it defers containment
  // to the caller. The tree does its own CIDR math in memory (ipInCidr), so a
  // fleet that has folded forward makes no extra query at all.
  const legacyCidrs = filtered.flatMap((f) => (f.criteria ? collectCidrs(f.criteria) : []));
  const matchedCidrs = legacyCidrs.length
    ? await cidrsContainingIp(asset.ipAddress, legacyCidrs)
    : new Set<string>();

  const out = new Map<string, ContactRow>();
  for (const c of byPin) out.set(c.id, c);
  for (const f of filtered) {
    if (out.has(f.contact.id)) continue; // already covered by a pin
    const hit = f.condition
      ? evaluateScopeCondition(f.condition, asset as ScopeConditionAsset)
      : assetMatchesCriteria(asset, f.criteria as TagCriteria, matchedCidrs);
    if (hit) out.set(f.contact.id, f.contact);
  }
  return Array.from(out.values());
}

/** Just the addresses — what the delivery expansion actually needs. */
export async function resolveContactEmailsForAsset(assetId: string): Promise<string[]> {
  const contacts = await resolveContactsForAsset(assetId);
  return contacts.map((c) => c.email);
}

// ─── Unified address-book search ────────────────────────────────────────────

/**
 * Search everything Polaris knows how to address: its own user accounts and the
 * contacts table (and, when `includeDirectory` is set and a directory
 * integration opted in, the organization's GAL — filled in by
 * directorySearchService).
 *
 * Deduped by lower-cased email with **user winning over contact**: a Polaris
 * user id is the more durable token because it survives the person changing
 * address, whereas a stored contact address does not.
 */
export interface AddressBookSearchOptions {
  limit?: number;
  callerUsername?: string | null;
  /**
   * Fan the query out LIVE to the opted-in AD / Entra directories. Nothing is
   * persisted on this path.
   *
   * Named `includeLiveDirectory` because there are now two different directory
   * questions and one word for both was a bug waiting to happen: this one asks
   * "query the directory right now", the next asks "show me rows the sync
   * already stored".
   */
  includeLiveDirectory?: boolean;
  /**
   * Include directory-SYNCED contact rows. The visibility gate; the route
   * derives it from the caller's permissions, never from their query string.
   */
  includeDirectorySynced?: boolean;
}

export async function searchAddressBook(
  query: string,
  opts: AddressBookSearchOptions = {},
): Promise<AddressBookEntry[]> {
  const limit = opts.limit ?? 50;
  const q = String(query ?? "").trim().toLowerCase();

  // The contacts half is resolved in SQL, and deliberately does NOT go through
  // listContacts / rowToContact: a typeahead entry needs five scalar columns,
  // whereas rowToContact re-validates both JSON filter blobs per row through
  // Zod. Reading the whole table and validating filters nobody asked about, on
  // every keystroke, is the exact cost this endpoint cannot carry once the
  // table can hold a whole company.
  //
  // `limit * 2 + 1` rather than `limit`: users and contacts are merged and then
  // deduped by address, so fetching exactly `limit` contacts could leave the
  // page short after a dedupe drops the ones that are also Polaris accounts.
  // The `+ 1` is what makes "there are more" detectable by the caller.
  const [users, contactRows] = await Promise.all([
    listRecipientUsers(),
    prisma.contact.findMany({
      where: {
        ...contactSearchWhere(q),
        // Same gate as the list route, same reason: a caller who may not browse
        // the synced roster must not be able to walk it a query at a time.
        ...(opts.includeDirectorySynced === true ? {} : { origin: "manual" }),
      },
      select: {
        id: true, email: true, name: true, description: true, createdBy: true,
        origin: true, kind: true, jobTitle: true, department: true, phone: true,
      },
      orderBy: [{ name: "asc" }, { email: "asc" }],
      take: limit * 2 + 1,
    }),
  ]);

  const entries: AddressBookEntry[] = [];
  for (const u of users) {
    if (!u.email) continue; // an account with no address can't be an email recipient
    entries.push({
      source: "user",
      id: u.id,
      email: u.email,
      name: u.displayName || u.username,
      description: "Polaris user account",
      kind: "person",
      pushDevices: u.pushDevices,
    });
  }
  for (const c of contactRows) {
    entries.push({
      // A synced row badges as the directory it came from rather than as a
      // plain contact, which is why `origin` stores the backend name: the
      // picker's existing entra / ad badges light up with no client change.
      source: (isDirectoryOrigin(c.origin) ? c.origin : "contact") as AddressBookEntry["source"],
      id: c.id,
      email: c.email,
      name: c.name,
      description: c.description,
      kind: (c.kind === "group" ? "group" : "person"),
      owned: !!opts.callerUsername && c.createdBy === opts.callerUsername,
      jobTitle: c.jobTitle,
      department: c.department,
      phone: c.phone,
      origin: c.origin,
    });
  }

  // Directory (GAL) hits rank BELOW the local sources: a Polaris account or a
  // curated contact is the entry an operator meant, and the directory is the
  // long tail. Live only — nothing here is persisted (see directorySearchService).
  if (opts.includeLiveDirectory && q.length >= MIN_DIRECTORY_QUERY) {
    try {
      for (const d of await searchDirectory(q, limit)) {
        entries.push({
          source: d.source,
          id: d.id,
          email: d.email,
          name: d.name,
          description: d.description,
          kind: d.kind,
        });
      }
    } catch (err) {
      // A directory outage must not break the local typeahead.
      logger.warn({ err }, "Directory search failed; returning local address-book results only");
    }
  }

  const seen = new Set<string>();
  const deduped = entries.filter((e) => {
    const key = e.email.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Still applied in JS, but over a bounded set and for one reason only: the
  // USER half is an unfiltered cached index, so it is the half that still needs
  // matching. Contacts arrived pre-filtered by SQL and directory hits were
  // matched upstream; re-testing them here is harmless and keeps one definition
  // of what "matches" means across the three sources.
  const filtered = q
    ? deduped.filter(
        (e) => e.email.toLowerCase().includes(q) || (e.name ?? "").toLowerCase().includes(q),
      )
    : deduped;

  // Prefix matches first — the same ranking the appmap/scope typeaheads use, so
  // typing "no" surfaces "noc@…" above "jane.donovan@…".
  const ranked = q
    ? filtered.sort((a, b) => {
        const aPre = a.email.toLowerCase().startsWith(q) || (a.name ?? "").toLowerCase().startsWith(q);
        const bPre = b.email.toLowerCase().startsWith(q) || (b.name ?? "").toLowerCase().startsWith(q);
        if (aPre !== bPre) return aPre ? -1 : 1;
        return (a.name ?? a.email).localeCompare(b.name ?? b.email);
      })
    : filtered;

  return ranked.slice(0, limit);
}
