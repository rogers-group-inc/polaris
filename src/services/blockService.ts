/**
 * src/services/blockService.ts
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { logEvent, buildChanges } from "./eventLogService.js";
import {
  normalizeCidr,
  isValidCidr,
  detectIpVersion,
} from "../utils/cidr.js";
import { lockBlockForSubnetWrites } from "./subnetService.js";

export interface CreateBlockInput {
  name: string;
  cidr: string;
  description?: string;
  tags?: string[];
  /** Session username stamped on the audit Event; omit for system callers. */
  actor?: string;
}

export interface UpdateBlockInput {
  name?: string;
  description?: string;
  tags?: string[];
  actor?: string;
}

export interface ListBlocksFilter {
  ipVersion?: "v4" | "v6";
  tag?: string;
}

// ─── List ─────────────────────────────────────────────────────────────────────

export async function listBlocks(filter: ListBlocksFilter = {}) {
  const blocks = await prisma.ipBlock.findMany({
    where: { ipVersion: filter.ipVersion },
    include: { _count: { select: { subnets: true } } },
    orderBy: { cidr: "asc" },
  });
  return filter.tag ? blocks.filter((b) => b.tags.includes(filter.tag!)) : blocks;
}

// ─── Get ──────────────────────────────────────────────────────────────────────

export async function getBlock(id: string) {
  const block = await prisma.ipBlock.findUnique({
    where: { id },
    include: {
      subnets: {
        include: { _count: { select: { reservations: true } } },
        orderBy: { cidr: "asc" },
      },
    },
  });
  if (!block) throw new AppError(404, `IP Block ${id} not found`);
  return block;
}

// ─── Create ───────────────────────────────────────────────────────────────────

export async function createBlock(input: CreateBlockInput) {
  if (!isValidCidr(input.cidr))
    throw new AppError(400, `Invalid CIDR notation: ${input.cidr}`);

  const normalizedCidr = normalizeCidr(input.cidr);
  const ipVersion = detectIpVersion(normalizedCidr);

  const existing = await prisma.ipBlock.findUnique({
    where: { cidr: normalizedCidr },
  });
  if (existing)
    throw new AppError(409, `IP Block with CIDR ${normalizedCidr} already exists`);

  const created = await prisma.ipBlock.create({
    data: {
      name: input.name,
      cidr: normalizedCidr,
      ipVersion,
      description: input.description,
      tags: input.tags ?? [],
    },
  });
  void logEvent({
    action: "block.created",
    resourceType: "block",
    resourceId: created.id,
    resourceName: input.name,
    actor: input.actor,
    message: `Block "${input.name}" (${input.cidr}) created`,
  });
  return created;
}

// ─── Update ───────────────────────────────────────────────────────────────────

export async function updateBlock(id: string, input: UpdateBlockInput) {
  const block = await prisma.ipBlock.findUnique({ where: { id } });
  if (!block) throw new AppError(404, `IP Block ${id} not found`);

  const updated = await prisma.ipBlock.update({
    where: { id },
    data: {
      name: input.name,
      description: input.description,
      tags: input.tags,
    },
  });
  const changes = buildChanges(
    { name: block.name, description: block.description, tags: block.tags },
    { name: updated.name, description: updated.description, tags: updated.tags },
  );
  void logEvent({
    action: "block.updated",
    resourceType: "block",
    resourceId: id,
    resourceName: input.name || updated.name,
    actor: input.actor,
    message: `Block "${input.name || updated.name}" updated`,
    details: changes ? { changes } : undefined,
  });
  return updated;
}

// ─── Delete ───────────────────────────────────────────────────────────────────

// Business rule 4: a block that still holds networks is refused with a 409,
// whatever state those networks are in (deprecated ones included). The FK
// cascades, so without this guard one click silently took every network — and
// every reservation under them — with it. The operator moves the networks to
// another block (subnetService.moveSubnet), archives or deletes them first.
//
// The count and the delete share one transaction under the block's subnet
// write lock (rule 20a), so a network created or moved INTO this block by a
// concurrent writer is either seen by the count or waits until the block is
// gone (and then fails its own existence check) — never cascaded away unseen.
export async function deleteBlock(id: string, actor?: string) {
  const deleted = await prisma.$transaction(async (tx) => {
    await lockBlockForSubnetWrites(tx, id);
    const block = await tx.ipBlock.findUnique({
      where: { id },
      include: { _count: { select: { subnets: true } } },
    });
    if (!block) throw new AppError(404, `IP Block ${id} not found`);

    const networks = block._count.subnets;
    if (networks > 0)
      throw new AppError(
        409,
        `Cannot delete block ${block.cidr} — it still contains ${networks} network${networks === 1 ? "" : "s"}. ` +
          `Move ${networks === 1 ? "it" : "them"} to another block, archive or delete ${networks === 1 ? "it" : "them"} first.`,
      );

    return tx.ipBlock.delete({ where: { id } });
  });
  void logEvent({
    action: "block.deleted",
    resourceType: "block",
    resourceId: id,
    resourceName: deleted.name,
    actor,
    message: `Block deleted`,
  });
  return deleted;
}
