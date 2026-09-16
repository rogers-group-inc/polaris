/**
 * src/services/subnetService.ts
 *
 * ─── Overlap invariant (business rules 1 + 2) ───────────────────────────────
 *
 * "No overlapping subnets within a block" is a check-then-insert, which means
 * it is only as strong as whatever serializes the check against the insert.
 * Before 2026-08 nothing did: createSubnet read every sibling CIDR, tested
 * cidrOverlaps in JS, then issued a separate `subnet.create`, with no
 * transaction and no DB constraint. Two concurrent requests both passed and
 * both inserted, and overlapping subnets then let the same address be handed
 * to two owners. bulkAllocate had a transaction but, at READ COMMITTED, its
 * in-transaction re-read still could not see a concurrent writer's uncommitted
 * rows and took no locks.
 *
 * Every subnet-creating path now goes through one of two seams here:
 *   - createSubnetRowChecked(data) — single-row writers (createSubnet, and the
 *     DHCP-discovery create in discoveryEngine): one transaction that takes the
 *     per-block advisory lock, re-reads siblings, re-tests overlap, inserts.
 *   - lockBlockForSubnetWrites(tx, blockId) — batch writers (bulkAllocate) that
 *     already own a transaction and create many rows under one lock.
 *
 * The lock is per (block), so allocation in unrelated blocks stays fully
 * parallel; it is an xact lock, so it releases on commit or rollback with no
 * unlock bookkeeping. Backstop: a UNIQUE index on (blockId, cidr) added by
 * migration 20260806000000, which catches the exact-duplicate case (the usual
 * race outcome — two "next available" calls returning the SAME cidr) even from
 * a future code path that forgets the lock.
 *
 * Why no exclusion constraint for true overlap: stock PostgreSQL has no
 * GiST-indexable overlap operator for `inet`/`cidr` (btree_gist's gist_inet_ops
 * covers the btree operators only, not `&&`), so an
 * `EXCLUDE ... (inet(cidr) WITH &&)` does not build without a third-party
 * extension. The advisory lock is the exact guard; the unique index is the
 * portable backstop.
 */

import type { Prisma, SubnetStatus } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { DEFAULT_PLACEHOLDER_MAC_PREFIX } from "../utils/mac.js";
import { getPlaceholderPrefix } from "./reservationMacService.js";
import { isFortinetIntegrationType } from "../utils/pollingCompatibility.js";
import { integrationPushEnabled } from "./reservationPushService.js";
import { logEvent, buildChanges } from "./eventLogService.js";
import {
  normalizeCidr,
  isValidCidr,
  isValidIpAddress,
  cidrContains,
  cidrOverlaps,
  findNextAvailableSubnet,
  detectIpVersion,
  enumerateSubnetIps,
  packIntoAnchor,
  usableHostCount,
} from "../utils/cidr.js";
import {
  assertNotExcluded,
  loadExclusions,
} from "./subnetExclusionService.js";
import { exclusionsOverlapping, type ExclusionLike } from "../utils/subnetExclusion.js";

/**
 * The client handed to an interactive `$transaction` callback.
 *
 * Derived from our own `prisma` singleton rather than `Prisma.TransactionClient`
 * because db.ts wraps the base client in a `$extends` (the hostnameOverride /
 * ipOverride / clampMonitoredForStatus guards), and the extended client's model
 * delegates are not assignable to the unextended `Prisma.TransactionClient`.
 */
type TxClient = Omit<
  typeof prisma,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

// ─── Per-block write serialization ──────────────────────────────────────────
//
// Advisory-lock namespace. The two-int form of pg_advisory_xact_lock keys on
// (classid, objid); classid partitions namespaces so two unrelated lock users
// can never collide on a coincidentally-equal objid. The retention prune uses
// 0x504c5253 ("PLRS") with objid 1 — see PRUNE_LOCK_CLASSID in
// monitoringService.ts. Subnet writes take the next classid in that sequence
// with objid = hashtext(blockId).
const SUBNET_LOCK_CLASSID = 0x504c5254; // "PLRT" — subnet-per-block write lock

/**
 * Serialize subnet writes for one block against every other subnet writer.
 *
 * MUST be the first statement inside the caller's transaction, before the
 * sibling re-read whose result the overlap decision depends on. Blocks until
 * any other holder commits or rolls back; releases automatically at end of
 * transaction (no unlock path to leak).
 *
 * hashtext() can collide across different blockIds, which is harmless: a
 * collision only means two unrelated blocks briefly serialize against each
 * other. It can never let two writers into the same block concurrently.
 */
export async function lockBlockForSubnetWrites(
  tx: TxClient,
  blockId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SUBNET_LOCK_CLASSID}::int, hashtext(${blockId})::int)`;
}

/**
 * Insert one subnet row with the overlap invariant enforced under the per-block
 * lock. The caller has already validated shape (CIDR validity, containment in
 * the parent block, IP-version match) and normalized the CIDR; this seam owns
 * only the part that has to be atomic: lock, re-read siblings, re-test overlap,
 * insert.
 *
 * Throws AppError 409 when a sibling overlaps — including the case where the
 * sibling was committed by a concurrent writer between the caller's own
 * pre-check and this call, which is exactly the race that used to slip through.
 * A P2002 from the (blockId, cidr) unique index is translated to the same 409
 * so callers see one error shape.
 *
 * It is ALSO the one place every subnet-creating path meets the exclusion list
 * (business rule 42), which is why the check lives here rather than in each
 * caller: manual create, auto-allocate and the discovery create all come
 * through this seam, so an excluded CIDR cannot be recorded by any of them.
 * `opts.exclusions` lets a caller that already loaded the set (discovery, which
 * loads it once per run) skip the read.
 */
export async function createSubnetRowChecked(
  data: Prisma.SubnetUncheckedCreateInput,
  opts?: { exclusions?: readonly ExclusionLike[] },
) {
  const { blockId, cidr } = data;
  await assertNotExcluded(cidr, opts?.exclusions);
  try {
    return await prisma.$transaction(async (tx) => {
      await lockBlockForSubnetWrites(tx, blockId);
      const siblings = await tx.subnet.findMany({
        where: { blockId },
        select: { cidr: true },
      });
      const overlap = siblings.find((s) => cidrOverlaps(s.cidr, cidr));
      if (overlap) {
        throw new AppError(
          409,
          `Subnet ${cidr} overlaps with existing subnet ${overlap.cidr}`,
        );
      }
      return await tx.subnet.create({ data });
    });
  } catch (err: any) {
    if (err?.code === "P2002") {
      throw new AppError(409, `Subnet ${cidr} already exists in this block`);
    }
    throw err;
  }
}

// ─── IP → containing-subnet context ─────────────────────────────────────────
//
// Each asset row in the UI carries an `ipContext` so the table can render a
// "View Lease" button that jumps into the network slide-over at the asset's
// IP. The button needs to know which subnet contains the IP (subnetId/cidr);
// the active reservation summary (if any) is included for any future per-row
// indicators. One subnet load + one IN-list reservation query covers an entire
// page of assets. Also the single implementation of the most-specific-
// containing-subnet SQL (`cidr >>= ip`, `masklen DESC`) — the
// dns_resolved reconciler resolves its target subnet through this too.

export interface IpContext {
  subnetId: string;
  subnetCidr: string;
  reservation: { id: string; createdBy: string | null; sourceType: string } | null;
}

export async function buildIpContexts(ips: string[]): Promise<Map<string, IpContext>> {
  // Pre-filter in JS: drop empties and anything that isn't a parseable IP.
  // Postgres `inet` cast throws on bad input and we have no PG15-safe TRY_CAST,
  // so we keep bad strings out of the query entirely. Subnet cidrs are written
  // through cidr.ts validation, so we trust those.
  const distinct = Array.from(new Set(ips.filter((ip) => !!ip && isValidIpAddress(ip))));
  if (distinct.length === 0) return new Map();
  // Single round-trip: containment + reservation join in Postgres. `DISTINCT ON`
  // with `masklen DESC` picks the most-specific containing subnet per IP — the
  // routing-style answer when subnets nest.
  const rows = await prisma.$queryRaw<Array<{
    ip: string;
    subnet_id: string;
    subnet_cidr: string;
    reservation_id: string | null;
    reservation_created_by: string | null;
    reservation_source_type: string | null;
  }>>`
    WITH input_ips(ip) AS (SELECT unnest(${distinct}::text[]))
    SELECT DISTINCT ON (i.ip)
      i.ip                  AS ip,
      s.id                  AS subnet_id,
      s.cidr                AS subnet_cidr,
      r.id                  AS reservation_id,
      r."createdBy"         AS reservation_created_by,
      r."sourceType"::text  AS reservation_source_type
    FROM input_ips i
    JOIN subnets s
      ON s.status <> 'deprecated'
     AND s.cidr::cidr >>= i.ip::inet
    LEFT JOIN reservations r
      ON r."subnetId"  = s.id
     AND r."ipAddress" = i.ip
     AND r.status      = 'active'
    ORDER BY i.ip, masklen(s.cidr::cidr) DESC
  `;
  const out = new Map<string, IpContext>();
  for (const row of rows) {
    out.set(row.ip, {
      subnetId: row.subnet_id,
      subnetCidr: row.subnet_cidr,
      reservation: row.reservation_id
        ? { id: row.reservation_id, createdBy: row.reservation_created_by, sourceType: row.reservation_source_type as string }
        : null,
    });
  }
  return out;
}

export interface CreateSubnetInput {
  blockId: string;
  cidr: string;
  name: string;
  purpose?: string;
  vlan?: number;
  tags?: string[];
  createdBy?: string;
  /** Session username stamped on the audit Event; omit for system callers. */
  actor?: string;
  /** Discriminates the audit message — allocateNextSubnet sets "auto-allocate". */
  via?: "auto-allocate";
}

export interface UpdateSubnetInput {
  name?: string;
  purpose?: string;
  status?: SubnetStatus;
  vlan?: number;
  tags?: string[];
  convertToManual?: boolean;
  mergeIntegration?: boolean;
  actor?: string;
}

export interface ListSubnetsFilter {
  blockId?: string;
  status?: SubnetStatus;
  tag?: string;
  createdBy?: string;
  limit?: number;
  offset?: number;
}

// ─── List ─────────────────────────────────────────────────────────────────────

/**
 * Usable host addresses in a subnet, or `null` when the figure would be
 * meaningless or unsafe to quote: IPv6 (2^64-scale counts don't survive a
 * double, and nobody fills one) and any CIDR the parser refuses. Callers treat
 * `null` as "no denominator" and show the count alone — never a 0% bar, which
 * would be a positive claim that the network is empty.
 */
function usableHostsOrNull(cidr: string): number | null {
  try {
    if (detectIpVersion(cidr) !== "v4") return null;
    return usableHostCount(cidr);
  } catch {
    return null;
  }
}

export async function listSubnets(filter: ListSubnetsFilter = {}) {
  const limit = Math.min(filter.limit || 50, 10000);
  const offset = filter.offset || 0;

  const where: Record<string, unknown> = {};
  if (filter.blockId) where.blockId = filter.blockId;
  if (filter.status) where.status = filter.status;
  if (filter.createdBy) where.createdBy = filter.createdBy;
  // In the WHERE, not filtered in JS after the fact: a post-paginate filter
  // returned short (or empty) pages while later pages held matches, and
  // `total` counted the unfiltered set.
  if (filter.tag) where.tags = { has: filter.tag };

  const [subnets, total, allRowCounts] = await Promise.all([
    prisma.subnet.findMany({
      where,
      include: {
        block: { select: { name: true, cidr: true } },
        integration: { select: { id: true, name: true } },
        // FILTERED on purpose: `_count.reservations` is what the Networks
        // list's Reservations column shows and sorts on, so it counts the
        // addresses actually held — active rows carrying an IP. Released and
        // expired rows are kept forever (reservationService soft-releases; only
        // cleanupStaleDnsResolvedReleased ever prunes any of them), so the old
        // unfiltered count read 300 reservations on a /24 once a DHCP-leased
        // network had churned, and the utilization beside it would have been
        // over 100%. A whole-subnet reservation (ipAddress = null) is excluded
        // deliberately — it consumes no individual address and already shows as
        // status "reserved". Same numerator as ipService.subnetCapacity and the
        // IP panel's footer bar, which is what keeps the three agreeing.
        _count: {
          select: { reservations: { where: { status: "active", ipAddress: { not: null } } } },
        },
      },
      orderBy: { cidr: "asc" },
      skip: offset,
      take: limit,
    }),
    prisma.subnet.count({ where }),
    // Every reservation row, live or not, grouped by subnet: the delete /
    // archive confirmations name how many rows the cascade takes with it, and
    // that number has to include the released history the column hides. One
    // aggregate scoped by the same WHERE — not a per-row count, which at 2000
    // networks would be 2000 queries.
    prisma.reservation.groupBy({
      by: ["subnetId"],
      where: { subnet: where as Prisma.SubnetWhereInput },
      _count: { _all: true },
    }),
  ]);

  const totalBySubnet = new Map(allRowCounts.map((r) => [r.subnetId, r._count._all]));

  const withUtilization = subnets.map((s) => {
    const usableHosts = usableHostsOrNull(s.cidr);
    const active = s._count.reservations;
    return {
      ...s,
      usableHosts,
      // Rounded to one decimal: the cell prints a whole number and carries the
      // precise figure in its tooltip, but the sort has to separate a /22 at
      // 12.1% from one at 12.4%.
      utilizationPercent:
        usableHosts && usableHosts > 0
          ? Math.round((active / usableHosts) * 1000) / 10
          : null,
      totalReservations: totalBySubnet.get(s.id) ?? 0,
    };
  });

  return { subnets: withUtilization, total, limit, offset };
}

// ─── Get ──────────────────────────────────────────────────────────────────────

export async function getSubnet(id: string) {
  const subnet = await prisma.subnet.findUnique({
    where: { id },
    include: {
      block: true,
      integration: { select: { id: true, name: true } },
      reservations: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!subnet) throw new AppError(404, `Subnet ${id} not found`);
  return subnet;
}

// ─── Create ───────────────────────────────────────────────────────────────────

export async function createSubnet(input: CreateSubnetInput) {
  if (!isValidCidr(input.cidr))
    throw new AppError(400, `Invalid CIDR notation: ${input.cidr}`);

  const normalizedCidr = normalizeCidr(input.cidr);

  // Load parent block
  const block = await prisma.ipBlock.findUnique({ where: { id: input.blockId } });
  if (!block) throw new AppError(404, `IP Block ${input.blockId} not found`);

  // Subnet must be within the parent block
  if (!cidrContains(block.cidr, normalizedCidr))
    throw new AppError(
      400,
      `Subnet ${normalizedCidr} is not within block ${block.cidr}`
    );

  // IP version must match the block
  if (detectIpVersion(normalizedCidr) !== block.ipVersion)
    throw new AppError(
      400,
      `Subnet IP version does not match block IP version (${block.ipVersion})`
    );

  // No overlapping sibling subnets. The check and the insert happen together
  // inside createSubnetRowChecked, under the per-block advisory lock — doing
  // the findMany here and the create as a separate statement is what let two
  // concurrent requests both pass (see the overlap-invariant note at the top
  // of this file). It throws 409 on overlap or on the unique-index violation.
  const created = await createSubnetRowChecked({
    blockId: input.blockId,
    cidr: normalizedCidr,
    name: input.name,
    purpose: input.purpose,
    vlan: input.vlan,
    tags: input.tags ?? [],
    status: "available",
    createdBy: input.createdBy,
  });
  void logEvent({
    action: "subnet.created",
    resourceType: "subnet",
    resourceId: created.id,
    resourceName: input.name,
    actor: input.actor,
    message: input.via === "auto-allocate"
      ? `Subnet "${input.name}" (${created.cidr}) auto-allocated`
      : `Subnet "${input.name}" (${input.cidr}) created`,
  });
  return created;
}

// ─── Auto-allocate next available ────────────────────────────────────────────

export async function allocateNextSubnet(
  blockId: string,
  prefixLength: number,
  metadata: Omit<CreateSubnetInput, "blockId" | "cidr">
) {
  const block = await prisma.ipBlock.findUnique({ where: { id: blockId } });
  if (!block) throw new AppError(404, `IP Block ${blockId} not found`);

  if (block.ipVersion !== "v4")
    throw new AppError(400, "Auto-allocation is currently only supported for IPv4 blocks");

  if (prefixLength < 8 || prefixLength > 32)
    throw new AppError(400, "Prefix length must be between 8 and 32");

  // Pick-then-create, so the pick can go stale: two concurrent auto-allocates
  // read the same sibling set and choose the SAME free CIDR. createSubnet's
  // locked insert now turns the loser into a clean 409 instead of a silent
  // duplicate — but the caller asked for "any free /N", so a 409 here would be
  // the wrong answer. Re-pick against the now-committed state and try again;
  // each attempt sees one more taken CIDR, so a handful of retries absorbs far
  // more concurrency than this endpoint will ever see. Only the overlap/dup 409
  // is retried — a genuine "block full" 409 is raised by the pick itself and
  // returns immediately.
  // Excluded ranges (business rule 42) are TAKEN space here, not a refusal.
  // The caller asked for "any free /N", so an excluded candidate has to be
  // skipped over the way an allocated one is — 409-ing on it would turn an
  // exclusion into a wall the operator has to notice and work around.
  const excludedCidrs = exclusionsOverlapping(block.cidr, await loadExclusions())
    .map((ex) => ex.cidr);

  const MAX_ATTEMPTS = 5;
  for (let attempt = 1; ; attempt++) {
    const existing = await prisma.subnet.findMany({
      where: { blockId },
      select: { cidr: true },
    });

    const nextCidr = findNextAvailableSubnet(
      block.cidr,
      [...existing.map((s) => s.cidr), ...excludedCidrs],
      prefixLength
    );

    if (!nextCidr)
      throw new AppError(
        409,
        `No available /${prefixLength} subnet found in block ${block.cidr}`
      );

    try {
      return await createSubnet({ ...metadata, blockId, cidr: nextCidr, via: "auto-allocate" });
    } catch (err: any) {
      const lostRace = err instanceof AppError && err.httpStatus === 409;
      if (!lostRace || attempt >= MAX_ATTEMPTS) throw err;
    }
  }
}

// ─── Bulk allocation from a template ─────────────────────────────────────────

/**
 * A row in a bulk-allocate template.
 *
 * A regular entry has a name and optional VLAN and produces a subnet.
 * A skip entry (`skip: true`) reserves address space inside the packed
 * anchor region without creating a subnet — used to leave gaps between
 * allocations so later templates land on a clean boundary. The route layer
 * validates that `name` is present whenever `skip` is not true.
 */
export interface BulkAllocateEntry {
  skip?: boolean;
  name?: string;
  prefixLength: number;
  vlan?: number | null;
}

export interface BulkAllocateInput {
  blockId: string;
  prefix: string;
  entries: BulkAllocateEntry[];
  tags?: string[];
  /**
   * Minimum alignment granularity for the group. If the template's combined
   * footprint needs a larger region, that larger prefix is used instead.
   * Defaults to 24 if omitted.
   */
  anchorPrefix?: number;
  createdBy?: string;
  /** Session username stamped on the audit Event; omit for system callers. */
  actor?: string;
}

export interface BulkAllocateResult {
  created: Array<{ name: string; cidr: string; id: string }>;
  anchorCidr: string;
  effectiveAnchorPrefix: number;
}

/**
 * Allocate multiple subnets from one template invocation, anchor-aligned.
 *
 * All entries are placed inside a single contiguous region aligned to the
 * effective anchor prefix (= the larger of the requested anchor and the
 * smallest block that contains the group's packed footprint). Entries are
 * packed in caller order with per-entry prefix alignment padding.
 *
 * All-or-nothing: either every subnet is created in one transaction, or the
 * call throws and nothing changes.
 */
export async function bulkAllocate(input: BulkAllocateInput): Promise<BulkAllocateResult> {
  if (!input.prefix || !input.prefix.trim()) {
    throw new AppError(400, "A site/prefix name is required");
  }
  if (!Array.isArray(input.entries) || input.entries.length === 0) {
    throw new AppError(400, "At least one entry is required");
  }

  const requestedAnchor = input.anchorPrefix ?? 24;
  if (!Number.isInteger(requestedAnchor) || requestedAnchor < 8 || requestedAnchor > 32) {
    throw new AppError(400, "Anchor prefix must be between /8 and /32");
  }

  for (const e of input.entries) {
    if (!Number.isInteger(e.prefixLength) || e.prefixLength < 8 || e.prefixLength > 32) {
      const label = e.skip ? "skip" : e.name ?? "unnamed";
      throw new AppError(400, `Entry "${label}" has an invalid prefix length`);
    }
    if (!e.skip && (!e.name || !e.name.trim())) {
      throw new AppError(400, "Every non-skip entry must have a name");
    }
  }

  const hasCreatable = input.entries.some((e) => !e.skip);
  if (!hasCreatable) {
    throw new AppError(400, "At least one non-skip entry is required");
  }

  const block = await prisma.ipBlock.findUnique({ where: { id: input.blockId } });
  if (!block) throw new AppError(404, `IP Block ${input.blockId} not found`);
  if (block.ipVersion !== "v4") {
    throw new AppError(400, "Auto-allocation is currently only supported for IPv4 blocks");
  }

  const prefix = input.prefix.trim();
  const tags = input.tags ?? [];

  // Compute the packed CIDRs under a transaction. The transaction alone gives
  // all-or-nothing, NOT mutual exclusion: at READ COMMITTED the re-read below
  // cannot see a concurrent writer's uncommitted inserts and takes no locks, so
  // two bulk allocations against the same block could both pick the same free
  // anchor region and both commit. The advisory lock is what makes the re-read
  // authoritative, and it is the same lock createSubnetRowChecked takes, so
  // batch and single-row writers serialize against each other too.
  // Excluded ranges are unavailable space for the packer, same as an allocated
  // sibling (business rule 42) — so a template can never land an entry inside a
  // CIDR the operator excluded, and the anchor search moves past it instead.
  const excluded = exclusionsOverlapping(block.cidr, await loadExclusions());

  const result = await prisma.$transaction(async (tx) => {
    await lockBlockForSubnetWrites(tx, input.blockId);
    const existing = await tx.subnet.findMany({
      where: { blockId: input.blockId },
      select: { cidr: true },
    });
    const taken = [...existing.map((s) => s.cidr), ...excluded.map((ex) => ex.cidr)];

    const packed = packIntoAnchor(
      block.cidr,
      taken,
      input.entries,
      requestedAnchor
    );
    if (!packed) {
      throw new AppError(
        409,
        `No free /${requestedAnchor}-aligned region in block ${block.cidr} large enough to hold the template`
      );
    }

    // Defence in depth: double-check each creatable assignment against the
    // existing set. packIntoAnchor already guarantees the anchor region is
    // clear; skip entries reserve space but don't get created.
    for (const a of packed.assignments) {
      if (a.entry.skip) continue;
      const overlap = existing.find((s) => cidrOverlaps(s.cidr, a.cidr));
      if (overlap) {
        throw new AppError(409, `Computed subnet ${a.cidr} overlaps existing ${overlap.cidr}`);
      }
      const excludedHit = excluded.find((ex) => cidrOverlaps(ex.cidr, a.cidr));
      if (excludedHit) {
        throw new AppError(
          409,
          `Computed subnet ${a.cidr} falls inside excluded range ${excludedHit.cidr} ("${excludedHit.name}")`,
        );
      }
    }

    const created: BulkAllocateResult["created"] = [];
    for (const a of packed.assignments) {
      if (a.entry.skip) continue;
      const subnetName = `${prefix}_${a.entry.name}`;
      const normalized = normalizeCidr(a.cidr);
      const row = await tx.subnet.create({
        data: {
          blockId: input.blockId,
          cidr: normalized,
          name: subnetName,
          vlan: a.entry.vlan ?? undefined,
          tags,
          status: "available",
          createdBy: input.createdBy,
        },
      });
      created.push({ id: row.id, name: row.name, cidr: row.cidr });
    }

    return {
      created,
      anchorCidr: packed.anchorCidr,
      effectiveAnchorPrefix: packed.effectiveAnchorPrefix,
    };
  });

  // ONE event for the whole batch, emitted strictly AFTER the transaction
  // commits — an event from inside would be a phantom on rollback. The
  // per-subnet tx.subnet.create calls intentionally emit nothing.
  const cidrs = result.created.map((s) => s.cidr).join(", ");
  void logEvent({
    action: "subnet.bulk-allocated",
    resourceType: "subnet",
    actor: input.actor,
    message: `Bulk-allocated ${result.created.length} subnet(s) with prefix "${input.prefix}" inside anchor ${result.anchorCidr}: ${cidrs}`,
    details: { created: result.created, anchorCidr: result.anchorCidr, effectiveAnchorPrefix: result.effectiveAnchorPrefix },
  });
  return result;
}

// ─── Preview (read-only sibling of bulkAllocate) ─────────────────────────────

export interface BulkAllocatePreviewInput {
  blockId: string;
  entries: BulkAllocateEntry[];
  anchorPrefix?: number;
}

export interface BulkAllocatePreviewResult {
  fits: boolean;
  anchorCidr: string | null;
  effectiveAnchorPrefix: number | null;
  assignments: Array<{ name: string | null; skip: boolean; prefixLength: number; cidr: string | null }>;
  totalAddresses: number;
  slashTwentyFourCount: number;
  blockCidr: string;
  /** Surface any validation error reached before running the packer. */
  error: string | null;
}

/**
 * Non-mutating preview of bulkAllocate. Computes the packed assignments and
 * whether they fit in the selected block, without creating any rows.
 */
export async function previewBulkAllocate(
  input: BulkAllocatePreviewInput
): Promise<BulkAllocatePreviewResult> {
  const requestedAnchor = input.anchorPrefix ?? 24;
  if (!Number.isInteger(requestedAnchor) || requestedAnchor < 8 || requestedAnchor > 32) {
    throw new AppError(400, "Anchor prefix must be between /8 and /32");
  }

  const block = await prisma.ipBlock.findUnique({ where: { id: input.blockId } });
  if (!block) throw new AppError(404, `IP Block ${input.blockId} not found`);

  // Compute footprint numbers even if we bail early (so the UI can still show totals).
  let totalAddresses = 0;
  for (const e of input.entries) {
    if (!Number.isInteger(e.prefixLength) || e.prefixLength < 8 || e.prefixLength > 32) {
      // surface invalid entry but keep going — totals aren't meaningful yet
      return {
        fits: false,
        anchorCidr: null,
        effectiveAnchorPrefix: null,
        assignments: [],
        totalAddresses: 0,
        slashTwentyFourCount: 0,
        blockCidr: block.cidr,
        error: `An entry has an invalid prefix length`,
      };
    }
    totalAddresses += 2 ** (32 - e.prefixLength);
  }
  const slashTwentyFourCount = Math.ceil(totalAddresses / 256);

  if (block.ipVersion !== "v4") {
    return {
      fits: false,
      anchorCidr: null,
      effectiveAnchorPrefix: null,
      assignments: [],
      totalAddresses,
      slashTwentyFourCount,
      blockCidr: block.cidr,
      error: "Auto-allocation is currently only supported for IPv4 blocks",
    };
  }

  if (input.entries.length === 0) {
    return {
      fits: false,
      anchorCidr: null,
      effectiveAnchorPrefix: null,
      assignments: [],
      totalAddresses,
      slashTwentyFourCount,
      blockCidr: block.cidr,
      error: null,
    };
  }

  const existing = await prisma.subnet.findMany({
    where: { blockId: input.blockId },
    select: { cidr: true },
  });
  // Same taken-space list bulkAllocate packs against, or the preview would show
  // a plan the mutating call then refuses (business rule 42).
  const excludedCidrs = exclusionsOverlapping(block.cidr, await loadExclusions())
    .map((ex) => ex.cidr);

  const packed = packIntoAnchor(
    block.cidr,
    [...existing.map((s) => s.cidr), ...excludedCidrs],
    input.entries,
    requestedAnchor
  );

  if (!packed) {
    return {
      fits: false,
      anchorCidr: null,
      effectiveAnchorPrefix: null,
      assignments: input.entries.map((e) => ({
        name: e.skip ? null : e.name ?? null,
        skip: !!e.skip,
        prefixLength: e.prefixLength,
        cidr: null,
      })),
      totalAddresses,
      slashTwentyFourCount,
      blockCidr: block.cidr,
      error: null,
    };
  }

  return {
    fits: true,
    anchorCidr: packed.anchorCidr,
    effectiveAnchorPrefix: packed.effectiveAnchorPrefix,
    assignments: packed.assignments.map((a) => ({
      name: a.entry.skip ? null : a.entry.name ?? null,
      skip: !!a.entry.skip,
      prefixLength: a.entry.prefixLength,
      cidr: a.cidr,
    })),
    totalAddresses,
    slashTwentyFourCount,
    blockCidr: block.cidr,
    error: null,
  };
}

// ─── Update ───────────────────────────────────────────────────────────────────

export async function updateSubnet(id: string, input: UpdateSubnetInput) {
  const subnet = await prisma.subnet.findUnique({ where: { id } });
  if (!subnet) throw new AppError(404, `Subnet ${id} not found`);

  const data: any = {
    name: input.name,
    purpose: input.purpose,
    status: input.status,
    vlan: input.vlan,
    tags: input.tags,
  };
  if (input.convertToManual) {
    data.discoveredBy = null;
    data.fortigateDevice = null;
  }

  const updated = await prisma.subnet.update({ where: { id }, data });
  const changes = buildChanges(
    { name: subnet.name, purpose: subnet.purpose, status: subnet.status, vlan: subnet.vlan, tags: subnet.tags },
    { name: updated.name, purpose: updated.purpose, status: updated.status, vlan: updated.vlan, tags: updated.tags },
  );
  void logEvent({
    action: "subnet.updated",
    resourceType: "subnet",
    resourceId: id,
    resourceName: input.name || updated.name,
    actor: input.actor,
    message: `Subnet "${input.name || updated.name}" updated`,
    details: changes ? { changes } : undefined,
  });
  return updated;
}

// ─── IP Enumeration ──────────────────────────────────────────────────────────

/** One full Reservation row, as the IP panel's DTO builder takes it. */
type SubnetIpReservationRow = Awaited<ReturnType<typeof prisma.reservation.findMany>>[number];

export async function getSubnetIps(id: string, page: number, pageSize: number) {
  // Reservations are NOT included here. This endpoint answers ONE page of
  // addresses (50-256), and an actively-leased /20 or /21 carries thousands of
  // reservations — every one of which used to be shipped from Postgres and
  // walked in memory to build a map that only the page's addresses were ever
  // looked up in. The IPv4 path below loads just the page's rows; only the
  // IPv6 path, which returns every reservation as its result, still needs all
  // of them. `hasConflict` keeps its whole-subnet meaning via a count.
  const subnet = await prisma.subnet.findUnique({
    where: { id },
    include: {
      // config is included so the response can derive `pushEligible` for the
      // reserve modals — the Reservation Push toggle on the integration
      // determines whether MAC becomes required at create time.
      integration: { select: { id: true, name: true, type: true, config: true } },
    },
  });
  if (!subnet) throw new AppError(404, `Subnet ${id} not found`);

  const isIpv6 = detectIpVersion(subnet.cidr) === "v6";

  // Push eligibility: only manual per-IP reservations on subnets discovered
  // by an FMG or standalone FortiGate integration with pushReservations=true
  // are pushed. The frontend uses this to mark the MAC field required and
  // validate before submitting.
  const integrationType = subnet.integration?.type;
  const pushEligible =
    !isIpv6 &&
    integrationPushEnabled(subnet.integration) &&
    !!subnet.fortigateDevice;

  // Refresh eligibility: only subnets discovered by an FMG / FortiGate
  // integration with a known device can be refreshed via the IP panel button.
  // Independent of pushReservations — refresh is a read-only reconcile.
  const refreshEligible =
    !isIpv6 &&
    (isFortinetIntegrationType(integrationType)) &&
    !!subnet.fortigateDevice;

  // Never fail the panel over a settings read — the generator falls back to the
  // compiled-in default client-side when this is absent.
  // Conflict flag counts across the WHOLE subnet (it warns about the subnet,
  // not the page), so it stays a count rather than riding the page's rows.
  const [macPlaceholderPrefix, conflictCount] = await Promise.all([
    getPlaceholderPrefix().catch(() => DEFAULT_PLACEHOLDER_MAC_PREFIX),
    prisma.reservation.count({ where: { subnetId: id, conflictMessage: { not: null } } }),
  ]);

  const subnetInfo = {
    name: subnet.name,
    cidr: subnet.cidr,
    status: subnet.status,
    vlan: subnet.vlan,
    purpose: subnet.purpose,
    // Strip config off the integration object before returning — it can hold
    // sensitive fields and the frontend only needs id/name/type.
    integration: subnet.integration
      ? { id: subnet.integration.id, name: subnet.integration.name, type: subnet.integration.type }
      : null,
    fortigateDevice: subnet.fortigateDevice,
    pushEligible,
    refreshEligible,
    // The prefix the reserve modals' "Generate" button builds a placeholder MAC
    // from. It rides this payload rather than its own fetch because that button
    // is used by `reservations:write` callers who typically have no Server
    // Settings access, and the panel already fetches this.
    macPlaceholderPrefix,
    lastDiscoveredAt: subnet.lastDiscoveredAt,
    hasConflict: conflictCount > 0,
    conflictMessage: conflictCount > 0
      ? "One or more IPs have conflicts"
      : null,
  };

  const toReservationDto = (r: SubnetIpReservationRow) => ({
    id: r.id,
    hostname: r.hostname,
    owner: r.owner,
    // macAddress feeds the IP panel's MAC column directly. Without this the
    // column relies on a `MAC: …` substring inside `notes` (the legacy
    // discovery-side breadcrumb), which means operator-edited MACs that
    // landed on the dedicated column don't render.
    macAddress: r.macAddress,
    status: r.status,
    sourceType: r.sourceType,
    // How the gate hands the address out, orthogonal to sourceType (which says
    // who owns it). The panel needs it to tell a managed AP/switch row the gate
    // merely LEASES — offer Reserve, label it as a lease — from one backed by a
    // real MAC→IP binding, which stays authoritative.
    dhcpBinding: r.dhcpBinding,
    notes: r.notes,
    expiresAt: r.expiresAt,
    createdBy: r.createdBy,
    conflictMessage: r.conflictMessage,
  });

  // DHCP discovery commonly produces multiple reservations for the same host
  // (one per interface MAC), but Asset.ipAddress only points at the most
  // recent primary IP — so direct ipAddress lookup links just one row to the
  // asset. Fall back to hostname matching for the remaining rows so every
  // reservation that came from the same asset gets the Asset button.
  if (isIpv6) {
    // A v6 subnet is not enumerable, so the reservations ARE the result —
    // every row is returned and there is nothing to narrow to.
    const allReservations = await prisma.reservation.findMany({ where: { subnetId: id } });
    const ipv6Addrs = allReservations.filter(r => r.ipAddress).map(r => r.ipAddress!);
    const ipv6Hostnames = Array.from(new Set(
      allReservations.map(r => r.hostname).filter((h): h is string => !!h),
    ));
    const v6Assets = (ipv6Addrs.length > 0 || ipv6Hostnames.length > 0)
      ? await prisma.asset.findMany({
          where: {
            OR: [
              ...(ipv6Addrs.length > 0 ? [{ ipAddress: { in: ipv6Addrs } }] : []),
              ...(ipv6Hostnames.length > 0 ? [{ hostname: { in: ipv6Hostnames } }] : []),
            ],
          },
          select: { id: true, ipAddress: true, hostname: true },
        })
      : [];
    const assetByIpV6 = new Map<string, string>();
    const assetByHostnameV6 = new Map<string, string>();
    for (const a of v6Assets) {
      if (a.ipAddress) assetByIpV6.set(a.ipAddress, a.id);
      if (a.hostname && !assetByHostnameV6.has(a.hostname)) assetByHostnameV6.set(a.hostname, a.id);
    }

    const ips = allReservations
      .filter(r => r.ipAddress)
      .map(r => ({
        address: r.ipAddress!,
        type: "host" as const,
        reservation: toReservationDto(r),
        assetId:
          assetByIpV6.get(r.ipAddress!) ??
          (r.hostname ? assetByHostnameV6.get(r.hostname) ?? null : null),
      }));
    return {
      subnet: subnetInfo,
      ips,
      ipv6: true,
      totalIps: ips.length,
      page: 1,
      pageSize: ips.length,
    };
  }

  const { addresses, total } = enumerateSubnetIps(subnet.cidr, page, pageSize);
  const pageAddrs = addresses.map(a => a.address);

  // Only the rows this page can display. The dedupe below is unchanged —
  // several reservations can share an IP across statuses (a released row
  // beside the active one), and active still wins.
  const pageReservations = pageAddrs.length > 0
    ? await prisma.reservation.findMany({ where: { subnetId: id, ipAddress: { in: pageAddrs } } })
    : [];

  const reservationMap = new Map<string, SubnetIpReservationRow>();
  for (const r of pageReservations) {
    if (r.ipAddress) {
      const existing = reservationMap.get(r.ipAddress);
      if (!existing || (r.status === "active" && existing.status !== "active")) {
        reservationMap.set(r.ipAddress, r);
      }
    }
  }
  const pageHostnames = Array.from(new Set(
    pageAddrs
      .map(a => reservationMap.get(a)?.hostname)
      .filter((h): h is string => !!h),
  ));
  const pageAssets = (pageAddrs.length > 0 || pageHostnames.length > 0)
    ? await prisma.asset.findMany({
        where: {
          OR: [
            ...(pageAddrs.length > 0 ? [{ ipAddress: { in: pageAddrs } }] : []),
            ...(pageHostnames.length > 0 ? [{ hostname: { in: pageHostnames } }] : []),
          ],
        },
        select: { id: true, ipAddress: true, hostname: true },
      })
    : [];
  const assetByIp = new Map<string, string>();
  const assetByHostname = new Map<string, string>();
  for (const a of pageAssets) {
    if (a.ipAddress) assetByIp.set(a.ipAddress, a.id);
    if (a.hostname && !assetByHostname.has(a.hostname)) assetByHostname.set(a.hostname, a.id);
  }

  const ips = addresses.map(addr => {
    const r = reservationMap.get(addr.address);
    return {
      address: addr.address,
      type: addr.type,
      reservation: r ? toReservationDto(r) : null,
      assetId:
        assetByIp.get(addr.address) ??
        (r?.hostname ? assetByHostname.get(r.hostname) ?? null : null),
    };
  });

  return {
    subnet: subnetInfo,
    ips,
    ipv6: false,
    totalIps: total,
    page,
    pageSize,
  };
}

// ─── Delete ───────────────────────────────────────────────────────────────────

export async function deleteSubnet(id: string, actor?: string) {
  const subnet = await prisma.subnet.findUnique({
    where: { id },
    include: {
      reservations: {
        select: { id: true, ipAddress: true, hostname: true, owner: true, status: true },
      },
    },
  });

  if (!subnet) throw new AppError(404, `Subnet ${id} not found`);

  const activeCount = await prisma.reservation.count({
    where: { subnetId: id, status: "active" },
  });
  if (activeCount > 0)
    throw new AppError(
      409,
      `Cannot delete subnet ${subnet.cidr} — it has ${activeCount} active reservation(s)`
    );

  const deletedReservations = subnet.reservations;
  await prisma.subnet.delete({ where: { id } });

  const resCount = deletedReservations.length;
  void logEvent({
    action: "subnet.deleted",
    resourceType: "subnet",
    resourceId: id,
    resourceName: subnet.name,
    actor,
    message: resCount > 0
      ? `Subnet "${subnet.name}" (${subnet.cidr}) deleted with ${resCount} reservation(s)`
      : `Subnet "${subnet.name}" (${subnet.cidr}) deleted`,
    details: resCount > 0 ? { deletedReservations } : undefined,
  });
  return { ...subnet, deletedReservations };
}
