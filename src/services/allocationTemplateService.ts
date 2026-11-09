/**
 * src/services/allocationTemplateService.ts
 *
 * Saved multi-subnet allocation templates. Each template is a named, ordered
 * list of subnet entries (name, prefixLength, optional vlan) used by the
 * "Auto-Allocate Next" modal to carve out several subnets at once.
 *
 * Stored as a single JSON blob in the Setting table under SETTING_KEY.
 */

import { randomUUID } from "node:crypto";
import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";

const SETTING_KEY = "networkAllocationTemplates";

interface TemplateEntry {
  /** True if this row only reserves space (no subnet created). */
  skip?: boolean;
  /** Required unless `skip` is true. */
  name?: string;
  prefixLength: number;
  vlan?: number | null;
}

export interface AllocationTemplate {
  id: string;
  name: string;
  entries: TemplateEntry[];
  anchorPrefix?: number;
}

export interface SaveTemplateInput {
  id?: string;
  name: string;
  entries: TemplateEntry[];
  anchorPrefix?: number;
}

function normalizeEntry(e: TemplateEntry): TemplateEntry {
  if (e.skip === true) {
    return { skip: true, prefixLength: Number(e.prefixLength) };
  }
  const out: TemplateEntry = {
    name: String(e.name || "").trim(),
    prefixLength: Number(e.prefixLength),
  };
  if (e.vlan !== undefined && e.vlan !== null && !Number.isNaN(Number(e.vlan))) {
    out.vlan = Number(e.vlan);
  }
  return out;
}

function validateTemplate(input: SaveTemplateInput): void {
  if (!input.name || !input.name.trim()) {
    throw new AppError(400, "Template name is required");
  }
  if (!Array.isArray(input.entries) || input.entries.length === 0) {
    throw new AppError(400, "Template must have at least one entry");
  }
  for (const e of input.entries) {
    const pl = Number(e.prefixLength);
    if (!Number.isInteger(pl) || pl < 8 || pl > 32) {
      const label = e.skip ? "skip" : e.name ?? "unnamed";
      throw new AppError(400, `Entry "${label}" has an invalid prefix length (must be 8-32)`);
    }
    if (!e.skip) {
      if (!e.name || !String(e.name).trim()) {
        throw new AppError(400, "Every non-skip entry must have a name");
      }
      if (e.vlan !== undefined && e.vlan !== null) {
        const v = Number(e.vlan);
        if (!Number.isInteger(v) || v < 1 || v > 4094) {
          throw new AppError(400, `Entry "${e.name}" has an invalid VLAN (must be 1-4094)`);
        }
      }
    }
  }
}

async function loadAll(): Promise<AllocationTemplate[]> {
  const row = await prisma.setting.findUnique({ where: { key: SETTING_KEY } });
  if (!row?.value) return [];
  const val = row.value as unknown;
  if (!Array.isArray(val)) return [];
  return val as AllocationTemplate[];
}

async function persistAll(templates: AllocationTemplate[]): Promise<void> {
  await prisma.setting.upsert({
    where: { key: SETTING_KEY },
    update: { value: templates as any },
    create: { key: SETTING_KEY, value: templates as any },
  });
}

export async function listTemplates(): Promise<AllocationTemplate[]> {
  const all = await loadAll();
  return all
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function saveTemplate(input: SaveTemplateInput): Promise<AllocationTemplate> {
  validateTemplate(input);
  const name = input.name.trim();
  const entries = input.entries.map(normalizeEntry);
  const all = await loadAll();

  if (input.id) {
    const idx = all.findIndex((t) => t.id === input.id);
    if (idx === -1) throw new AppError(404, `Template ${input.id} not found`);
    // Block renaming onto another template's name
    if (all.some((t, i) => i !== idx && t.name.toLowerCase() === name.toLowerCase())) {
      throw new AppError(409, `A template named "${name}" already exists`);
    }
    all[idx] = { id: input.id, name, entries, ...(input.anchorPrefix !== undefined && { anchorPrefix: input.anchorPrefix }) };
    await persistAll(all);
    return all[idx];
  }

  if (all.some((t) => t.name.toLowerCase() === name.toLowerCase())) {
    throw new AppError(409, `A template named "${name}" already exists`);
  }
  const created: AllocationTemplate = { id: randomUUID(), name, entries, ...(input.anchorPrefix !== undefined && { anchorPrefix: input.anchorPrefix }) };
  all.push(created);
  await persistAll(all);
  return created;
}

export async function deleteTemplate(id: string): Promise<void> {
  const all = await loadAll();
  const next = all.filter((t) => t.id !== id);
  if (next.length === all.length) throw new AppError(404, `Template ${id} not found`);
  await persistAll(next);
}
