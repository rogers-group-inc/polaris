/**
 * src/services/subnetExclusionService.ts — CIDRs declared out of scope for the
 * networks list (business rule 42).
 *
 * WHAT THIS FIXES
 * A subnet in Polaris is ONE row per CIDR (`@@unique([blockId, cidr])`), which
 * is right for address space an operator allocates and wrong for address space
 * that is the same at every site: a management VLAN, an out-of-band range, an
 * appliance's fixed subnet. Every site's FortiGate reports it, so the first
 * site discovered creates the row and every other site collides with it — and
 * since business rule 41 the collision is a CONFLICT, not just noise: each
 * site's gate answers with its own serial, so the row's chassis identity reads
 * as `replaced` on every run and discovery raises a `chassis-replaced` card
 * about a box nobody swapped.
 *
 * An exclusion answers that with "this CIDR is not one network — do not try to
 * record it". Discovery skips a covered entry WHOLE (no create, no update, no
 * chassis check) and leaves it out of the stale sweep, so nothing about an
 * excluded CIDR can raise a conflict or move a row.
 *
 * THREE DECISIONS WORTH KNOWING
 *   1. Adding an exclusion NEVER destroys anything. Networks already in the
 *      list whose CIDR it covers are reported back (`matchCount` / `matches`)
 *      and left alone — retiring one stays the operator's explicit archive
 *      action (`subnetArchiveService.archiveSubnet`). An exclusion is a
 *      statement about what gets recorded from now on.
 *   2. The CIDR is the IDENTITY and is frozen after create. `updateExclusion`
 *      takes name/notes only; re-pointing an exclusion at different address
 *      space in place would silently un-exclude what the operator excluded, so
 *      that is a delete plus an add.
 *   3. IPv4 only. The containment math is netmask-backed and the space this
 *      exists for is v4; storing a v6 exclusion that could never match anything
 *      is worse than refusing it.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { logEvent } from "./eventLogService.js";
import { isValidCidr, normalizeCidr, detectIpVersion } from "../utils/cidr.js";
import {
  findCoveringExclusion,
  type ExclusionLike,
} from "../utils/subnetExclusion.js";

/** How many matching live networks a list/create response names outright. */
const MATCH_SAMPLE = 20;

export interface SubnetExclusionRow {
  id: string;
  cidr: string;
  name: string;
  notes: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface ExclusionMatch {
  id: string;
  cidr: string;
  name: string;
  status: string;
  blockName: string | null;
}

export interface SubnetExclusionDto extends SubnetExclusionRow {
  /** Live networks this exclusion covers. Reported, never acted on (see 1). */
  matchCount: number;
  matches: ExclusionMatch[];
}

export interface CreateExclusionInput {
  cidr: string;
  name: string;
  notes?: string | null;
  createdBy?: string;
  actor?: string;
}

export interface UpdateExclusionInput {
  name?: string;
  notes?: string | null;
  actor?: string;
}

// ─── Reads ───────────────────────────────────────────────────────────────────

/**
 * Every exclusion, bare. THE read for enforcement paths — discovery loads it
 * once per run and hands the array down rather than re-reading per subnet.
 */
export async function loadExclusions(): Promise<SubnetExclusionRow[]> {
  return prisma.subnetExclusion.findMany({ orderBy: { cidr: "asc" } });
}

/**
 * Exclusions decorated with the live networks each one covers.
 *
 * Containment is JS-side (netmask) rather than SQL `>>=` because the exclusion
 * set is tiny — and doing it here keeps ONE definition of "covers"
 * (utils/subnetExclusion) instead of a second one in SQL that could drift.
 */
export async function listExclusions(): Promise<SubnetExclusionDto[]> {
  const [exclusions, subnets] = await Promise.all([
    loadExclusions(),
    prisma.subnet.findMany({
      select: {
        id: true,
        cidr: true,
        name: true,
        status: true,
        block: { select: { name: true } },
      },
    }),
  ]);
  return exclusions.map((ex) => {
    const covered = subnets.filter((s) => findCoveringExclusion(s.cidr, [ex]) !== null);
    return {
      ...ex,
      matchCount: covered.length,
      matches: covered.slice(0, MATCH_SAMPLE).map((s) => ({
        id: s.id,
        cidr: s.cidr,
        name: s.name,
        status: String(s.status),
        blockName: s.block?.name ?? null,
      })),
    };
  });
}

// ─── Enforcement helper ──────────────────────────────────────────────────────

/**
 * Refuse a CIDR that an exclusion covers.
 *
 * `known` lets a caller that already loaded the set (discovery, a batch
 * allocator inside a transaction) skip the read; omit it and one is done here.
 * Throws 409 — the same shape as the overlap refusal, since to a caller both
 * mean "this address space is not available to record".
 */
export async function assertNotExcluded(
  cidr: string,
  known?: readonly ExclusionLike[],
): Promise<void> {
  const exclusions = known ?? (await loadExclusions());
  const covering = findCoveringExclusion(cidr, exclusions);
  if (covering) {
    throw new AppError(
      409,
      `Subnet ${cidr} is excluded${covering.name ? ` as "${covering.name}"` : ""} ` +
        `(${covering.cidr}) and cannot be added to the networks list`,
    );
  }
}

// ─── Writes ──────────────────────────────────────────────────────────────────

export async function createExclusion(
  input: CreateExclusionInput,
): Promise<SubnetExclusionDto> {
  const raw = String(input.cidr || "").trim();
  const name = String(input.name || "").trim();
  if (!name) throw new AppError(400, "Exclusion name is required");
  if (!isValidCidr(raw)) throw new AppError(400, `Invalid CIDR notation: ${raw}`);
  if (detectIpVersion(raw) !== "v4") {
    throw new AppError(400, "Subnet exclusions are IPv4-only");
  }
  const cidr = normalizeCidr(raw);

  const clash = await prisma.subnetExclusion.findUnique({ where: { cidr } });
  if (clash) {
    throw new AppError(409, `${cidr} is already excluded as "${clash.name}"`);
  }

  const created = await prisma.subnetExclusion.create({
    data: {
      cidr,
      name,
      notes: input.notes?.trim() || null,
      createdBy: input.createdBy ?? null,
    },
  });

  // The exclusion is a forward statement, so any network already in the list is
  // reported rather than touched — the operator decides whether to retire it.
  const decorated = (await listExclusions()).find((e) => e.id === created.id)!;

  void logEvent({
    action: "subnet.exclusion.created",
    resourceType: "subnet-exclusion",
    resourceId: created.id,
    resourceName: created.name,
    actor: input.actor,
    message:
      `Subnet ${cidr} excluded as "${created.name}" — discovery will no longer record it` +
      (decorated.matchCount > 0
        ? `; ${decorated.matchCount} existing network(s) match and were left in place`
        : ""),
    details: {
      cidr,
      name: created.name,
      existingMatches: decorated.matches.map((m) => m.cidr),
      matchCount: decorated.matchCount,
    },
  });
  return decorated;
}

/**
 * Rename an exclusion (and re-note it). The CIDR is deliberately not editable —
 * see decision 2 in the file header.
 */
export async function updateExclusion(
  id: string,
  input: UpdateExclusionInput,
): Promise<SubnetExclusionDto> {
  const existing = await prisma.subnetExclusion.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, `Subnet exclusion ${id} not found`);

  const data: { name?: string; notes?: string | null } = {};
  if (input.name !== undefined) {
    const name = String(input.name).trim();
    if (!name) throw new AppError(400, "Exclusion name is required");
    data.name = name;
  }
  if (input.notes !== undefined) data.notes = input.notes?.trim() || null;
  if (Object.keys(data).length === 0) {
    return (await listExclusions()).find((e) => e.id === id)!;
  }

  const saved = await prisma.subnetExclusion.update({ where: { id }, data });
  void logEvent({
    action: "subnet.exclusion.updated",
    resourceType: "subnet-exclusion",
    resourceId: saved.id,
    resourceName: saved.name,
    actor: input.actor,
    message:
      data.name && data.name !== existing.name
        ? `Subnet exclusion ${saved.cidr} renamed from "${existing.name}" to "${saved.name}"`
        : `Subnet exclusion "${saved.name}" (${saved.cidr}) updated`,
    details: { cidr: saved.cidr, previousName: existing.name, name: saved.name },
  });
  return (await listExclusions()).find((e) => e.id === saved.id)!;
}

export async function deleteExclusion(id: string, actor?: string): Promise<void> {
  const existing = await prisma.subnetExclusion.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, `Subnet exclusion ${id} not found`);
  await prisma.subnetExclusion.delete({ where: { id } });
  void logEvent({
    action: "subnet.exclusion.deleted",
    resourceType: "subnet-exclusion",
    resourceId: id,
    resourceName: existing.name,
    actor,
    message:
      `Subnet exclusion "${existing.name}" (${existing.cidr}) removed — ` +
      `discovery may record this address space again`,
    details: { cidr: existing.cidr, name: existing.name },
  });
}
