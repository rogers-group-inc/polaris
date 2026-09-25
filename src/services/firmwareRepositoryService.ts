/**
 * src/services/firmwareRepositoryService.ts — the firmware repository
 * (Server Settings → Repository; business rule 87).
 *
 * Owns three things and their invariants:
 *
 *   THE TREE. manufacturer › device type (switch / access_point only) › model,
 *   built from the assets that exist plus the model nodes that hold images.
 *   A node with images and no assets is ORPHANED — flagged, never hidden, so
 *   the operator sees the images are still on disk.
 *
 *   IMAGES. One `.out` per row, bytes under FIRMWARE_DIR. A model node keeps
 *   TWO: a new upload becomes `primary`, the displaced primary becomes
 *   `backup`, and the displaced backup is removed by the rotation. The
 *   operator can swap the two. Identity — platform, version — is parsed from
 *   the image header; the model node is only where it is filed. Matching a
 *   device is by PLATFORM (the serial-prefix token), and only a PRIMARY image
 *   is offered unasked; the backup is offered as a named alternative when it
 *   is also strictly newer.
 *
 *   BINDINGS. Which device-admin login (an `http` Credential, authMode
 *   "form") signs in, at manufacturer, device-type or model scope; the most
 *   specific scope with a LIVE credential wins, and a binding whose credential
 *   was deleted falls through instead of shadowing a wider one (the rule-49
 *   posture: absent is not an error).
 *
 * Nothing here writes Asset. Nothing here talks to a device.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { prisma } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import { AppError } from "../utils/errors.js";
import { normalizeManufacturer } from "../utils/manufacturerNormalize.js";
import { FIRMWARE_DIR, FIRMWARE_INCOMING_DIR } from "../utils/paths.js";
import {
  identifyFirmwareImage,
  formatFirmwareVersion,
  compareFirmwareVersions,
  isStrictlyNewer,
  parseFirmwareVersion,
  platformFromSerial,
  IMAGE_HEADER_BYTES,
  type FirmwareVersion,
} from "../utils/firmwareVersion.js";
import { getCredential } from "./credentialService.js";
import { isDeviceLoginCredential, type HttpAuthConfig } from "../utils/httpCheck.js";
import { logEvent } from "./eventLogService.js";
import { engineKindForType, engineFor } from "./firmwareEngines/index.js";
import { listAssetTypes } from "./assetTypeService.js";
import { logger } from "../utils/logger.js";

export const FIRMWARE_ASSET_TYPES = ["switch", "access_point"] as const;
export type FirmwareAssetType = (typeof FIRMWARE_ASSET_TYPES)[number];
export const FIRMWARE_MAX_IMAGE_BYTES = 104_857_600;
export const FIRMWARE_IMAGE_ROLES = ["primary", "backup"] as const;
export type FirmwareImageRole = (typeof FIRMWARE_IMAGE_ROLES)[number];

export function isFirmwareAssetType(v: unknown): v is FirmwareAssetType {
  return v === "switch" || v === "access_point";
}

// ─── Shapes ───────────────────────────────────────────────────────────────────

export interface FirmwareImageRow {
  id: string;
  manufacturer: string;
  assetType: string;
  model: string;
  platform: string | null;
  version: FirmwareVersion | null;
  versionLabel: string;
  build: number | null;
  parsedFrom: string;
  role: FirmwareImageRole;
  filename: string;
  sizeBytes: number;
  sha256: string;
  notes: string | null;
  uploadedBy: string | null;
  uploadedAt: Date;
  /** The bytes are gone from disk (a restore without data/firmware, a bad volume). */
  fileMissing: boolean;
  warnings: string[];
}

export interface FirmwareBindingRef {
  id: string;
  credentialId: string | null;
  credentialName: string | null;
  /** The credential was deleted; resolution skips this row. */
  stale: boolean;
}

export interface EffectiveBinding {
  credentialId: string;
  credentialName: string;
  scope: "manufacturer" | "assetType" | "model";
}

export interface FirmwareModelNode {
  model: string;
  assetCount: number;
  orphaned: boolean;
  images: FirmwareImageRow[];
  binding: FirmwareBindingRef | null;
  effectiveBinding: EffectiveBinding | null;
}

export interface FirmwareTypeNode {
  assetType: string;
  label: string;
  engine: string | null;
  assetCount: number;
  binding: FirmwareBindingRef | null;
  effectiveBinding: EffectiveBinding | null;
  models: FirmwareModelNode[];
}

export interface FirmwareManufacturerNode {
  name: string;
  assetCount: number;
  binding: FirmwareBindingRef | null;
  effectiveBinding: EffectiveBinding | null;
  assetTypes: FirmwareTypeNode[];
}

export interface FirmwareTree {
  manufacturers: FirmwareManufacturerNode[];
}

type ImageRecord = {
  id: string; manufacturer: string; assetType: string; model: string; platform: string | null;
  versionMajor: number | null; versionMinor: number | null; versionPatch: number | null; build: number | null;
  versionLabel: string; parsedFrom: string; role: string; filename: string; sizeBytes: number; sha256: string;
  storagePath: string; notes: string | null; uploadedBy: string | null; uploadedAt: Date;
};

type BindingRecord = {
  id: string; manufacturer: string; assetType: string | null; model: string | null; credentialId: string | null;
  credential?: { id: string; name: string } | null;
};

function versionOf(r: { versionMajor: number | null; versionMinor: number | null; versionPatch: number | null; build: number | null }): FirmwareVersion | null {
  if (r.versionMajor === null) return null;
  const v: FirmwareVersion = { major: r.versionMajor };
  if (r.versionMinor !== null) v.minor = r.versionMinor;
  if (r.versionPatch !== null) v.patch = r.versionPatch;
  if (r.build !== null) v.build = r.build;
  return v;
}

/** Warnings an image carries wherever it is shown — why it may never be offered. */
function imageWarnings(r: ImageRecord, platformsUnderModel?: Set<string>): string[] {
  const out: string[] = [];
  if (!r.platform) out.push("Only the file name was readable, so no platform is known — this image will not be offered to any device.");
  else if (platformsUnderModel && platformsUnderModel.size > 0 && !platformsUnderModel.has(r.platform)) {
    out.push(`No asset under this model carries serial prefix ${r.platform}.`);
  }
  return out;
}

function toRow(r: ImageRecord, fileMissing = false, platformsUnderModel?: Set<string>): FirmwareImageRow {
  return {
    id: r.id,
    manufacturer: r.manufacturer,
    assetType: r.assetType,
    model: r.model,
    platform: r.platform,
    version: versionOf(r),
    versionLabel: r.versionLabel,
    build: r.build,
    parsedFrom: r.parsedFrom,
    role: r.role === "backup" ? "backup" : "primary",
    filename: r.filename,
    sizeBytes: r.sizeBytes,
    sha256: r.sha256,
    notes: r.notes,
    uploadedBy: r.uploadedBy,
    uploadedAt: r.uploadedAt,
    fileMissing,
    warnings: imageWarnings(r, platformsUnderModel),
  };
}

function bindingRef(b: BindingRecord | undefined): FirmwareBindingRef | null {
  if (!b) return null;
  return {
    id: b.id,
    credentialId: b.credentialId,
    credentialName: b.credential?.name ?? null,
    stale: b.credentialId === null,
  };
}

function nodeKey(manufacturer: string, assetType: string | null, model: string | null): string {
  return [manufacturer, assetType ?? "", model ?? ""].join("\u0000");
}

// ─── Disk ─────────────────────────────────────────────────────────────────────

export async function ensureFirmwareDirs(): Promise<void> {
  await mkdir(FIRMWARE_INCOMING_DIR, { recursive: true });
}

/** Absolute path of an image's bytes, refused when the stored path escapes FIRMWARE_DIR. */
export function resolveImagePath(storagePath: string): string {
  const abs = resolve(FIRMWARE_DIR, storagePath);
  if (abs !== FIRMWARE_DIR && !abs.startsWith(FIRMWARE_DIR + sep)) {
    throw new AppError(500, "Firmware image path escapes the repository directory");
  }
  return abs;
}

async function fileExists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

async function sha256OfFile(p: string): Promise<string> {
  return new Promise((res, rej) => {
    const h = createHash("sha256");
    createReadStream(p).on("data", (c) => h.update(c)).on("end", () => res(h.digest("hex"))).on("error", rej);
  });
}

async function readHead(p: string): Promise<Buffer> {
  const fh = await open(p, "r");
  try {
    const buf = Buffer.alloc(IMAGE_HEADER_BYTES);
    const { bytesRead } = await fh.read(buf, 0, IMAGE_HEADER_BYTES, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

// ─── The tree ─────────────────────────────────────────────────────────────────

async function typeLabels(): Promise<Map<string, string>> {
  try {
    const defs = await listAssetTypes();
    return new Map(defs.map((d: { name: string; label: string }) => [d.name, d.label]));
  } catch {
    return new Map([["switch", "Switch"], ["access_point", "Access Point"]]);
  }
}

/**
 * The whole Repository tab in one read: two groupBys (assets, images) and one
 * small findMany (bindings). The fold is in memory; at 2000 assets the asset
 * groupBy returns a couple of hundred (manufacturer, type, model) rows.
 */
export async function getFirmwareTree(): Promise<FirmwareTree> {
  const [assetGroups, images, bindings, labels] = await Promise.all([
    prisma.asset.groupBy({
      by: ["manufacturer", "assetType", "model"],
      where: { assetType: { in: [...FIRMWARE_ASSET_TYPES] }, manufacturer: { not: null }, status: { not: "decommissioned" } },
      _count: { _all: true },
    }),
    prisma.firmwareImage.findMany({ orderBy: [{ role: "asc" }, { uploadedAt: "desc" }] }),
    prisma.firmwareCredentialBinding.findMany({ include: { credential: { select: { id: true, name: true } } } }),
    typeLabels(),
  ]);

  // Serial prefixes per model node, for the "no asset carries this prefix" warning.
  const platformsByNode = await platformsPerModelNode();

  const bindingByKey = new Map<string, BindingRecord>();
  for (const b of bindings) bindingByKey.set(nodeKey(b.manufacturer, b.assetType, b.model), b as BindingRecord);

  type MfrAcc = { name: string; types: Map<string, { models: Map<string, { assetCount: number; images: ImageRecord[] }> }> };
  const mfrs = new Map<string, MfrAcc>();
  const mfr = (name: string): MfrAcc => {
    let m = mfrs.get(name);
    if (!m) { m = { name, types: new Map() }; mfrs.set(name, m); }
    return m;
  };
  const model = (m: MfrAcc, type: string, name: string) => {
    let t = m.types.get(type);
    if (!t) { t = { models: new Map() }; m.types.set(type, t); }
    let md = t.models.get(name);
    if (!md) { md = { assetCount: 0, images: [] }; t.models.set(name, md); }
    return md;
  };

  for (const g of assetGroups) {
    if (!g.manufacturer) continue;
    // An asset with no model still needs a place to be counted — its images
    // would be filed under "(no model)" if the operator wanted them.
    const md = model(mfr(g.manufacturer), g.assetType, g.model ?? "");
    md.assetCount += g._count._all;
  }
  for (const img of images) {
    model(mfr(img.manufacturer), img.assetType, img.model).images.push(img as ImageRecord);
  }

  const effectiveFor = (manufacturer: string, assetType: string | null, modelName: string | null): EffectiveBinding | null => {
    const tiers: Array<[BindingRecord | undefined, EffectiveBinding["scope"]]> = [
      [modelName !== null && assetType !== null ? bindingByKey.get(nodeKey(manufacturer, assetType, modelName)) : undefined, "model"],
      [assetType !== null ? bindingByKey.get(nodeKey(manufacturer, assetType, null)) : undefined, "assetType"],
      [bindingByKey.get(nodeKey(manufacturer, null, null)), "manufacturer"],
    ];
    for (const [b, scope] of tiers) {
      if (b && b.credentialId && b.credential) return { credentialId: b.credentialId, credentialName: b.credential.name, scope };
    }
    return null;
  };

  const manufacturers: FirmwareManufacturerNode[] = [];
  for (const m of Array.from(mfrs.values()).sort((a, b) => a.name.localeCompare(b.name))) {
    const assetTypes: FirmwareTypeNode[] = [];
    for (const type of FIRMWARE_ASSET_TYPES) {
      const t = m.types.get(type);
      if (!t) continue;
      const models: FirmwareModelNode[] = [];
      for (const [name, md] of Array.from(t.models.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
        const platforms = platformsByNode.get(nodeKey(m.name, type, name));
        models.push({
          model: name,
          assetCount: md.assetCount,
          orphaned: md.assetCount === 0 && md.images.length > 0,
          images: md.images
            .sort((a, b) => (a.role === b.role ? b.uploadedAt.getTime() - a.uploadedAt.getTime() : a.role === "primary" ? -1 : 1))
            .map((img) => toRow(img, false, platforms)),
          binding: bindingRef(bindingByKey.get(nodeKey(m.name, type, name))),
          effectiveBinding: effectiveFor(m.name, type, name),
        });
      }
      assetTypes.push({
        assetType: type,
        label: labels.get(type) ?? type,
        engine: engineKindForType(m.name, type),
        assetCount: models.reduce((n, x) => n + x.assetCount, 0),
        binding: bindingRef(bindingByKey.get(nodeKey(m.name, type, null))),
        effectiveBinding: effectiveFor(m.name, type, null),
        models,
      });
    }
    manufacturers.push({
      name: m.name,
      assetCount: assetTypes.reduce((n, x) => n + x.assetCount, 0),
      binding: bindingRef(bindingByKey.get(nodeKey(m.name, null, null))),
      effectiveBinding: effectiveFor(m.name, null, null),
      assetTypes,
    });
  }
  return { manufacturers };
}

/** Serial prefixes present under each (manufacturer, type, model) node — one select, tight columns. */
async function platformsPerModelNode(): Promise<Map<string, Set<string>>> {
  const rows = await prisma.asset.findMany({
    where: { assetType: { in: [...FIRMWARE_ASSET_TYPES] }, manufacturer: { not: null }, serialNumber: { not: null }, status: { not: "decommissioned" } },
    select: { manufacturer: true, assetType: true, model: true, serialNumber: true },
  });
  const out = new Map<string, Set<string>>();
  for (const r of rows) {
    const p = platformFromSerial(r.serialNumber);
    if (!p || !r.manufacturer) continue;
    const k = nodeKey(r.manufacturer, r.assetType, r.model ?? "");
    let s = out.get(k);
    if (!s) { s = new Set(); out.set(k, s); }
    s.add(p);
  }
  return out;
}

// ─── Images ───────────────────────────────────────────────────────────────────

export async function listImages(filter: { manufacturer?: string; assetType?: string; model?: string } = {}): Promise<FirmwareImageRow[]> {
  const where: Record<string, unknown> = {};
  if (filter.manufacturer) where.manufacturer = normalizeManufacturer(filter.manufacturer);
  if (filter.assetType) where.assetType = filter.assetType;
  if (filter.model !== undefined) where.model = filter.model;
  const rows = await prisma.firmwareImage.findMany({ where, orderBy: [{ manufacturer: "asc" }, { assetType: "asc" }, { model: "asc" }, { role: "asc" }] });
  const out: FirmwareImageRow[] = [];
  for (const r of rows) out.push(toRow(r as ImageRecord, !(await fileExists(resolveImagePath(r.storagePath)))));
  return out;
}

export async function getImage(id: string): Promise<FirmwareImageRow> {
  const r = await prisma.firmwareImage.findUnique({ where: { id } });
  if (!r) throw new AppError(404, "Firmware image not found");
  return toRow(r as ImageRecord, !(await fileExists(resolveImagePath(r.storagePath))));
}

export interface RegisterImageInput {
  tmpPath: string;
  originalName: string;
  sizeBytes: number;
  manufacturer: string;
  assetType: string;
  model: string;
  notes?: string | null;
  actor?: string | null;
}

export interface RegisterImageResult {
  image: FirmwareImageRow;
  /** The backup the rotation removed, if the node already held two. */
  rotatedOut: { id: string; versionLabel: string; filename: string } | null;
  /** The previous primary, now the backup. */
  demoted: { id: string; versionLabel: string } | null;
  warnings: string[];
}

async function activeRunsReferencing(imageIds: string[]): Promise<number> {
  if (imageIds.length === 0) return 0;
  return prisma.firmwareUpgradeRun.count({ where: { imageId: { in: imageIds }, status: { in: ["queued", "running"] } } });
}

/**
 * Register an upload that multer already wrote under FIRMWARE_INCOMING_DIR.
 * Identity from the header (filename fallback), sha256 by stream, then ONE
 * transaction rotates the node: the current backup is deleted, the current
 * primary becomes backup, the new row is primary. The rename to its final
 * name happens after the row exists; on any failure the temp file is removed
 * and nothing rotated.
 */
export async function registerUploadedImage(input: RegisterImageInput): Promise<RegisterImageResult> {
  const tmp = resolve(input.tmpPath);
  if (!tmp.startsWith(FIRMWARE_INCOMING_DIR + sep)) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw new AppError(400, "Upload landed outside the firmware incoming directory");
  }
  try {
    const manufacturer = normalizeManufacturer(input.manufacturer.trim());
    if (!manufacturer) throw new AppError(400, "manufacturer is required");
    if (!isFirmwareAssetType(input.assetType)) throw new AppError(400, "assetType must be switch or access_point");
    const model = input.model.trim();
    if (!model) throw new AppError(400, "model is required");
    if (input.sizeBytes <= 0) throw new AppError(400, "The uploaded file is empty");
    if (input.sizeBytes > FIRMWARE_MAX_IMAGE_BYTES) throw new AppError(413, `Firmware images are limited to ${FIRMWARE_MAX_IMAGE_BYTES} bytes (100 MiB)`);

    const head = await readHead(tmp);
    const identity = identifyFirmwareImage(head, input.originalName);
    if (!identity) {
      throw new AppError(400, "This file is not a recognisable firmware image — no Fortinet header and no version in the file name");
    }
    const warnings: string[] = [];
    if (identity.parsedFrom === "filename") {
      warnings.push("Only the file name was readable, so no platform is known — this image will not be offered to any device.");
    }
    if (identity.family === "switch" && input.assetType !== "switch") warnings.push("The image header says this is a FortiSwitch image, but it is being filed under an access-point model.");
    if (identity.family === "ap" && input.assetType !== "access_point") warnings.push("The image header says this is a FortiAP image, but it is being filed under a switch model.");
    if (identity.platform) {
      const platforms = (await platformsPerModelNode()).get(nodeKey(manufacturer, input.assetType, model));
      if (platforms && platforms.size > 0 && !platforms.has(identity.platform)) {
        warnings.push(`No asset under this model carries serial prefix ${identity.platform} (they carry ${Array.from(platforms).sort().join(", ")}).`);
      }
    }

    const sha256 = await sha256OfFile(tmp);
    const dup = await prisma.firmwareImage.findUnique({ where: { sha256 } });
    if (dup) {
      throw new AppError(409, `This exact image is already in the repository under ${dup.manufacturer} › ${dup.assetType} › ${dup.model} (${dup.versionLabel})`);
    }

    // The node's current pair.
    const existing = await prisma.firmwareImage.findMany({ where: { manufacturer, assetType: input.assetType, model } });
    const primary = existing.find((r) => r.role === "primary") ?? null;
    const backup = existing.find((r) => r.role === "backup") ?? null;
    if (backup && (await activeRunsReferencing([backup.id])) > 0) {
      throw new AppError(409, `The backup image (${backup.versionLabel}) is being flashed right now; the upload would remove it. Try again when that run finishes.`);
    }

    const versionLabel = formatFirmwareVersion(identity.version);
    const created = await prisma.$transaction(async (tx) => {
      if (backup) await tx.firmwareImage.delete({ where: { id: backup.id } });
      if (primary) await tx.firmwareImage.update({ where: { id: primary.id }, data: { role: "backup" } });
      return tx.firmwareImage.create({
        data: {
          manufacturer,
          assetType: input.assetType,
          model,
          platform: identity.platform,
          versionMajor: identity.version.major,
          versionMinor: identity.version.minor ?? null,
          versionPatch: identity.version.patch ?? null,
          build: identity.version.build ?? null,
          versionLabel,
          parsedFrom: identity.parsedFrom,
          role: "primary",
          filename: input.originalName.replace(/\\/g, "/").split("/").pop() ?? input.originalName,
          sizeBytes: input.sizeBytes,
          sha256,
          storagePath: "pending",
          notes: input.notes?.trim() || null,
          uploadedBy: input.actor ?? null,
        },
      });
    });
    const storagePath = `${created.id}.out`;
    await mkdir(FIRMWARE_DIR, { recursive: true });
    try {
      await rename(tmp, resolveImagePath(storagePath));
      await prisma.firmwareImage.update({ where: { id: created.id }, data: { storagePath } });
    } catch (err) {
      // Undo the row; the rotation already happened but the bytes never landed.
      await prisma.firmwareImage.delete({ where: { id: created.id } }).catch(() => undefined);
      throw err;
    }
    if (backup) await rm(resolveImagePath(backup.storagePath), { force: true }).catch(() => undefined);

    await logEvent({
      action: "firmware.image_uploaded",
      resourceType: "firmware_image",
      resourceId: created.id,
      resourceName: `${manufacturer} › ${input.assetType} › ${model} — ${versionLabel}`,
      actor: input.actor ?? undefined,
      level: "info",
      message: `Firmware ${versionLabel} (${identity.platform ?? "no platform"}) uploaded for ${manufacturer} ${model} as primary`
        + (primary ? `; ${primary.versionLabel} is now the backup` : "")
        + (backup ? `; ${backup.versionLabel} removed` : ""),
      details: { manufacturer, assetType: input.assetType, model, platform: identity.platform, versionLabel, sha256, sizeBytes: input.sizeBytes, parsedFrom: identity.parsedFrom, demoted: primary?.id ?? null, rotatedOut: backup?.id ?? null },
    });
    if (backup) {
      await logEvent({
        action: "firmware.image_deleted",
        resourceType: "firmware_image",
        resourceId: backup.id,
        resourceName: `${manufacturer} › ${input.assetType} › ${model} — ${backup.versionLabel}`,
        actor: input.actor ?? undefined,
        level: "warning",
        message: `Firmware ${backup.versionLabel} removed from ${manufacturer} ${model} by the upload of ${versionLabel} (a model keeps two images)`,
        details: { manufacturer, assetType: input.assetType, model, sha256: backup.sha256, rotation: true },
      });
    }
    const row = toRow({ ...(created as ImageRecord), storagePath }, false);
    row.warnings = warnings;
    return {
      image: row,
      rotatedOut: backup ? { id: backup.id, versionLabel: backup.versionLabel, filename: backup.filename } : null,
      demoted: primary ? { id: primary.id, versionLabel: primary.versionLabel } : null,
      warnings,
    };
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/** Swap a node's primary and backup. */
export async function setPrimaryImage(id: string, actor?: string | null): Promise<FirmwareImageRow> {
  const r = await prisma.firmwareImage.findUnique({ where: { id } });
  if (!r) throw new AppError(404, "Firmware image not found");
  if (r.role === "primary") throw new AppError(400, "That image is already the primary");
  const current = await prisma.firmwareImage.findFirst({ where: { manufacturer: r.manufacturer, assetType: r.assetType, model: r.model, role: "primary" } });
  await prisma.$transaction(async (tx) => {
    // Through a neutral role so the partial unique on "primary" never sees two.
    await tx.firmwareImage.update({ where: { id: r.id }, data: { role: "swapping" } });
    if (current) await tx.firmwareImage.update({ where: { id: current.id }, data: { role: "backup" } });
    await tx.firmwareImage.update({ where: { id: r.id }, data: { role: "primary" } });
  });
  await logEvent({
    action: "firmware.image_promoted",
    resourceType: "firmware_image",
    resourceId: r.id,
    resourceName: `${r.manufacturer} › ${r.assetType} › ${r.model} — ${r.versionLabel}`,
    actor: actor ?? undefined,
    level: "info",
    message: `Firmware ${r.versionLabel} is now the primary image for ${r.manufacturer} ${r.model}` + (current ? ` (${current.versionLabel} is the backup)` : ""),
    details: { manufacturer: r.manufacturer, assetType: r.assetType, model: r.model, demoted: current?.id ?? null },
  });
  return getImage(r.id);
}

/** Delete one image. Deleting the primary promotes the backup so a node never has a backup alone. */
export async function deleteImage(id: string, actor?: string | null): Promise<void> {
  const r = await prisma.firmwareImage.findUnique({ where: { id } });
  if (!r) throw new AppError(404, "Firmware image not found");
  if ((await activeRunsReferencing([r.id])) > 0) throw new AppError(409, "That image is being flashed right now — wait for the run to finish");
  const backup = r.role === "primary"
    ? await prisma.firmwareImage.findFirst({ where: { manufacturer: r.manufacturer, assetType: r.assetType, model: r.model, role: "backup" } })
    : null;
  await prisma.$transaction(async (tx) => {
    await tx.firmwareImage.delete({ where: { id: r.id } });
    if (backup) await tx.firmwareImage.update({ where: { id: backup.id }, data: { role: "primary" } });
  });
  await rm(resolveImagePath(r.storagePath), { force: true }).catch((err) => logger.warn({ err, id }, "firmware image row deleted but its file could not be removed"));
  await logEvent({
    action: "firmware.image_deleted",
    resourceType: "firmware_image",
    resourceId: r.id,
    resourceName: `${r.manufacturer} › ${r.assetType} › ${r.model} — ${r.versionLabel}`,
    actor: actor ?? undefined,
    level: "warning",
    message: `Firmware ${r.versionLabel} deleted from ${r.manufacturer} ${r.model}` + (backup ? ` (${backup.versionLabel} promoted to primary)` : ""),
    details: { manufacturer: r.manufacturer, assetType: r.assetType, model: r.model, sha256: r.sha256, promoted: backup?.id ?? null },
  });
}

/** Delete every image under a model node — the orphaned-node verb. */
export async function purgeModelImages(input: { manufacturer: string; assetType: string; model: string }, actor?: string | null): Promise<{ deleted: number }> {
  const manufacturer = normalizeManufacturer(input.manufacturer.trim());
  if (!manufacturer) throw new AppError(400, "manufacturer is required");
  if (!isFirmwareAssetType(input.assetType)) throw new AppError(400, "assetType must be switch or access_point");
  const rows = await prisma.firmwareImage.findMany({ where: { manufacturer, assetType: input.assetType, model: input.model } });
  if (rows.length === 0) return { deleted: 0 };
  if ((await activeRunsReferencing(rows.map((r) => r.id))) > 0) throw new AppError(409, "An image under this model is being flashed right now — wait for the run to finish");
  await prisma.firmwareImage.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
  for (const r of rows) await rm(resolveImagePath(r.storagePath), { force: true }).catch(() => undefined);
  await logEvent({
    action: "firmware.model_purged",
    resourceType: "firmware_image",
    resourceId: `${manufacturer}/${input.assetType}/${input.model}`,
    resourceName: `${manufacturer} › ${input.assetType} › ${input.model}`,
    actor: actor ?? undefined,
    level: "warning",
    message: `All firmware (${rows.map((r) => r.versionLabel).join(", ")}) deleted for ${manufacturer} ${input.model}`,
    details: { manufacturer, assetType: input.assetType, model: input.model, imageIds: rows.map((r) => r.id) },
  });
  return { deleted: rows.length };
}

// ─── Bindings ─────────────────────────────────────────────────────────────────

export interface BindingScope { manufacturer: string; assetType: string | null; model: string | null }

function assertBindingScope(input: { manufacturer: string; assetType?: string | null; model?: string | null }): BindingScope {
  const manufacturer = normalizeManufacturer((input.manufacturer ?? "").trim());
  if (!manufacturer) throw new AppError(400, "manufacturer is required");
  const assetType = input.assetType ? String(input.assetType) : null;
  const model = input.model !== undefined && input.model !== null ? String(input.model) : null;
  if (assetType !== null && !isFirmwareAssetType(assetType)) throw new AppError(400, "assetType must be switch or access_point");
  if (model !== null && assetType === null) throw new AppError(400, "A model binding needs its device type");
  return { manufacturer, assetType, model };
}

export async function listBindings(): Promise<Array<BindingScope & FirmwareBindingRef>> {
  const rows = await prisma.firmwareCredentialBinding.findMany({ include: { credential: { select: { id: true, name: true } } }, orderBy: [{ manufacturer: "asc" }, { assetType: "asc" }, { model: "asc" }] });
  return rows.map((b) => ({ manufacturer: b.manufacturer, assetType: b.assetType, model: b.model, ...bindingRef(b as BindingRecord)! }));
}

/** Bind a device-admin login at one scope (upsert by scope). `credentialId: null` removes the binding. */
export async function upsertBinding(input: { manufacturer: string; assetType?: string | null; model?: string | null; credentialId: string | null; actor?: string | null }): Promise<FirmwareBindingRef | null> {
  const scope = assertBindingScope(input);
  const existing = await prisma.firmwareCredentialBinding.findFirst({ where: { manufacturer: scope.manufacturer, assetType: scope.assetType, model: scope.model } });
  const scopeLabel = [scope.manufacturer, scope.assetType, scope.model].filter(Boolean).join(" › ");
  if (input.credentialId === null) {
    if (existing) {
      await prisma.firmwareCredentialBinding.delete({ where: { id: existing.id } });
      await logEvent({ action: "firmware.binding_deleted", resourceType: "firmware_binding", resourceId: existing.id, resourceName: scopeLabel, actor: input.actor ?? undefined, level: "info", message: `Device login binding removed at ${scopeLabel}`, details: { ...scope } });
    }
    return null;
  }
  const cred = await prisma.credential.findUnique({ where: { id: input.credentialId }, select: { id: true, name: true, type: true, config: true } });
  if (!cred) throw new AppError(400, "The selected credential no longer exists");
  if (cred.type !== "http" || !isDeviceLoginCredential((cred.config ?? {}) as HttpAuthConfig)) {
    throw new AppError(400, "A firmware binding needs an HTTP credential in \"Device admin login (form)\" mode");
  }
  const row = existing
    ? await prisma.firmwareCredentialBinding.update({ where: { id: existing.id }, data: { credentialId: cred.id }, include: { credential: { select: { id: true, name: true } } } })
    : await prisma.firmwareCredentialBinding.create({ data: { ...scope, credentialId: cred.id, createdBy: input.actor ?? null }, include: { credential: { select: { id: true, name: true } } } });
  await logEvent({
    action: "firmware.binding_set",
    resourceType: "firmware_binding",
    resourceId: row.id,
    resourceName: scopeLabel,
    actor: input.actor ?? undefined,
    level: "info",
    message: `Device login "${cred.name}" bound at ${scopeLabel}`,
    details: { ...scope, credentialId: cred.id, credentialName: cred.name },
  });
  return bindingRef(row as BindingRecord);
}

export async function deleteBinding(id: string, actor?: string | null): Promise<void> {
  const b = await prisma.firmwareCredentialBinding.findUnique({ where: { id } });
  if (!b) throw new AppError(404, "Firmware binding not found");
  await prisma.firmwareCredentialBinding.delete({ where: { id } });
  const scopeLabel = [b.manufacturer, b.assetType, b.model].filter(Boolean).join(" › ");
  await logEvent({ action: "firmware.binding_deleted", resourceType: "firmware_binding", resourceId: id, resourceName: scopeLabel, actor: actor ?? undefined, level: "info", message: `Device login binding removed at ${scopeLabel}`, details: { manufacturer: b.manufacturer, assetType: b.assetType, model: b.model } });
}

export interface ResolvedFirmwareCredential extends EffectiveBinding {
  username: string;
  password: string;
}

/**
 * The login an upgrade signs in with: model › device type › manufacturer,
 * most specific LIVE binding wins. Secrets are revealed here and nowhere
 * else, and only the caller that is about to open a socket should ask.
 */
export async function resolveFirmwareCredential(asset: { manufacturer: string | null; assetType: string; model: string | null }, opts: { revealSecrets: boolean }): Promise<ResolvedFirmwareCredential | EffectiveBinding | null> {
  if (!asset.manufacturer) return null;
  const manufacturer = normalizeManufacturer(asset.manufacturer);
  const rows = await prisma.firmwareCredentialBinding.findMany({
    where: {
      manufacturer,
      OR: [
        { assetType: asset.assetType, model: asset.model ?? "" },
        { assetType: asset.assetType, model: null },
        { assetType: null },
      ],
    },
    include: { credential: { select: { id: true, name: true } } },
  });
  const pick = (pred: (b: BindingRecord) => boolean): BindingRecord | undefined =>
    (rows as BindingRecord[]).find((b) => pred(b) && b.credentialId && b.credential);
  const tiers: Array<[BindingRecord | undefined, EffectiveBinding["scope"]]> = [
    [pick((b) => b.model !== null), "model"],
    [pick((b) => b.model === null && b.assetType !== null), "assetType"],
    [pick((b) => b.assetType === null), "manufacturer"],
  ];
  for (const [b, scope] of tiers) {
    if (!b || !b.credentialId || !b.credential) continue;
    const eff: EffectiveBinding = { credentialId: b.credentialId, credentialName: b.credential.name, scope };
    if (!opts.revealSecrets) return eff;
    const full = await getCredential(b.credentialId, { revealSecrets: true });
    const cfg = (full.config ?? {}) as HttpAuthConfig;
    if (!isDeviceLoginCredential(cfg) || typeof cfg.username !== "string" || typeof cfg.password !== "string" || !cfg.password) {
      // The credential lost its mode or its secret will not open — treat as
      // absent and fall through, exactly like a deleted one.
      continue;
    }
    return { ...eff, username: cfg.username, password: cfg.password };
  }
  return null;
}

// ─── Candidates ───────────────────────────────────────────────────────────────

export type CandidateReason = "ok" | "no-engine" | "no-serial" | "no-version" | "no-images" | "current" | "platform-unmatched";

export interface UpgradeCandidates {
  reason: CandidateReason;
  engine: string | null;
  platform: string | null;
  current: FirmwareVersion | null;
  /** The node's primary, when strictly newer and platform-matched. */
  primary: FirmwareImageRow | null;
  /** The same node's backup, when it too is strictly newer. */
  backup: FirmwareImageRow | null;
}

/** The node named by the asset's own model first, then the newest upload. */
function preferOwnModelNode<T extends { model: string; uploadedAt: Date }>(rows: T[], model: string | null): T[] {
  return rows.slice().sort((a, b) => {
    const aOwn = a.model === (model ?? "") ? 0 : 1;
    const bOwn = b.model === (model ?? "") ? 0 : 1;
    if (aOwn !== bOwn) return aOwn - bOwn;
    return b.uploadedAt.getTime() - a.uploadedAt.getTime();
  });
}

export type PrimaryImageLite = {
  manufacturer: string; assetType: string; model: string; platform: string | null;
  versionMajor: number | null; versionMinor: number | null; versionPatch: number | null; build: number | null;
  versionLabel: string; uploadedAt: Date;
};

/**
 * Every primary image that names a platform — ONE findMany over a table that
 * holds at most two rows per model node, for callers that compare a whole
 * fleet in memory (the `firmwareVsPrimary` automation field) rather than one
 * asset at a time.
 */
export async function loadPrimaryFirmwareImages(): Promise<PrimaryImageLite[]> {
  return prisma.firmwareImage.findMany({
    where: { role: "primary", platform: { not: null } },
    select: { manufacturer: true, assetType: true, model: true, platform: true, versionMajor: true, versionMinor: true, versionPatch: true, build: true, versionLabel: true, uploadedAt: true },
  });
}

export type FirmwareVsPrimary = "current" | "older" | "newer";
export type FirmwareVsPrimaryAsset = { assetType: string | null; manufacturer: string | null; model: string | null; serialNumber: string | null; osVersion: string | null };

/**
 * The primary image the Repository holds for THIS asset: same manufacturer
 * and device type, platform token == the serial's prefix, the asset's own
 * model node preferred when two nodes both hold one. null when the asset is
 * not a switch / access point, has no usable serial, or no primary names its
 * platform.
 */
export function primaryImageForAsset(asset: FirmwareVsPrimaryAsset, primaries: PrimaryImageLite[]): PrimaryImageLite | null {
  if (!asset.assetType || !(FIRMWARE_ASSET_TYPES as readonly string[]).includes(asset.assetType)) return null;
  if (!asset.manufacturer) return null;
  const platform = platformFromSerial(asset.serialNumber);
  if (!platform) return null;
  const manufacturer = normalizeManufacturer(asset.manufacturer);
  const matches = primaries.filter((p) => p.manufacturer === manufacturer && p.assetType === asset.assetType && p.platform === platform);
  return matches.length === 0 ? null : preferOwnModelNode(matches, asset.model)[0]!;
}

/**
 * How the asset's running firmware stands against the Repository's primary
 * for its platform (business rule 87) — the `firmwareVsPrimary` automation
 * field. null means NO READING, deliberately: not a switch / access point, no
 * usable serial, no readable version, or no primary image names its platform.
 * A reading of null would make `!= current` true of every device the
 * Repository knows nothing about, which is the inverse of what an operator
 * writing that rule means. "newer" is a reading too — an operator who made an
 * older image primary has devices that differ from it, and that is the fact
 * the field reports, not a judgement about which side is right.
 */
export function firmwareVsPrimary(asset: FirmwareVsPrimaryAsset, primaries: PrimaryImageLite[]): FirmwareVsPrimary | null {
  const current = parseFirmwareVersion(asset.osVersion);
  if (!current) return null;
  const primary = primaryImageForAsset(asset, primaries);
  if (!primary) return null;
  const target = versionOf(primary);
  if (!target) return null;
  const c = compareFirmwareVersions(current, target);
  return c === 0 ? "current" : c < 0 ? "older" : "newer";
}

/**
 * Which image(s) an asset may take. ZERO queries when no engine exists for
 * it; otherwise one indexed findMany on (manufacturer, assetType, platform).
 * Only a PRIMARY is offered unasked; the backup under the same model node is
 * named when it is also eligible. When two model nodes both hold a matching
 * primary (an FMG literal "FortiSwitch" node beside "FortiSwitch S108FF"),
 * the node named by the asset's own model wins, else the newest.
 */
export async function findUpgradeCandidates(asset: { manufacturer: string | null; assetType: string; model: string | null; serialNumber: string | null; osVersion: string | null }): Promise<UpgradeCandidates> {
  const engine = engineFor(asset.manufacturer, asset.assetType, asset.serialNumber);
  const platform = platformFromSerial(asset.serialNumber);
  const current = parseFirmwareVersion(asset.osVersion);
  const base = { engine: engine?.kind ?? null, platform, current, primary: null, backup: null };
  if (!engine) return { ...base, reason: "no-engine" };
  if (!platform) return { ...base, reason: "no-serial" };
  if (!current) return { ...base, reason: "no-version" };
  const manufacturer = normalizeManufacturer(asset.manufacturer!);
  const rows = await prisma.firmwareImage.findMany({ where: { manufacturer, assetType: asset.assetType, platform } });
  if (rows.length === 0) {
    const any = await prisma.firmwareImage.count({ where: { manufacturer, assetType: asset.assetType } });
    return { ...base, reason: any === 0 ? "no-images" : "platform-unmatched" };
  }
  const primaries = preferOwnModelNode(rows.filter((r) => r.role === "primary" && isStrictlyNewer(versionOf(r), current)), asset.model);
  if (primaries.length === 0) return { ...base, reason: "current" };
  const primary = primaries[0]!;
  const backup = rows.find((r) => r.role === "backup" && r.model === primary.model && isStrictlyNewer(versionOf(r), current)) ?? null;
  return {
    ...base,
    reason: "ok",
    primary: toRow(primary as ImageRecord),
    backup: backup ? toRow(backup as ImageRecord) : null,
  };
}

/** The device-list slide-in's cap. A manufacturer node on a large fleet can
 *  hold a couple of thousand switches and APs; the list is for finding one,
 *  and `total` still reports the true count. */
export const FIRMWARE_NODE_ASSET_LIMIT = 2000;

export type FirmwareNodeAsset = {
  id: string; hostname: string | null; ipAddress: string | null; assetType: string; model: string | null;
  serialNumber: string | null; osVersion: string | null; status: string; monitored: boolean; monitorStatus: string | null;
  /** How this device stands against its platform's primary image; null = the Repository cannot place it. */
  firmwareVsPrimary: FirmwareVsPrimary | null;
};

/**
 * The devices behind one Repository tree node — a manufacturer, a device type
 * under it, or a model under that — for the node's asset-count slide-in.
 *
 * Counts EXACTLY what `getFirmwareTree` counts, or the list disagrees with the
 * number the operator clicked: switches and access points only, not
 * decommissioned, the stored manufacturer string, and the tree's "(no model)"
 * node meaning a null or blank model — asked for with `noModel`, never with an
 * empty `model`, which a query string drops on the way (the list would widen to
 * the whole device type without a word). Two queries (count + a capped,
 * tightly-selected findMany) and one for the primaries, compared in memory.
 */
export async function listAssetsForNode(input: { manufacturer: string; assetType?: string | null; model?: string | null; noModel?: boolean }): Promise<{ total: number; limit: number; assets: FirmwareNodeAsset[] }> {
  const types = input.assetType ? [input.assetType] : [...FIRMWARE_ASSET_TYPES];
  const where: Prisma.AssetWhereInput = {
    manufacturer: input.manufacturer,
    assetType: { in: types },
    status: { not: "decommissioned" },
  };
  if (input.assetType) {
    if (input.noModel) where.OR = [{ model: null }, { model: "" }];
    else if (input.model) where.model = input.model;
  }
  const [total, rows, primaries] = await Promise.all([
    prisma.asset.count({ where }),
    prisma.asset.findMany({
      where,
      orderBy: [{ hostname: "asc" }, { ipAddress: "asc" }],
      take: FIRMWARE_NODE_ASSET_LIMIT,
      select: {
        id: true, hostname: true, ipAddress: true, assetType: true, model: true, serialNumber: true,
        osVersion: true, status: true, monitored: true, monitorStatus: true, manufacturer: true,
      },
    }),
    loadPrimaryFirmwareImages(),
  ]);
  return {
    total,
    limit: FIRMWARE_NODE_ASSET_LIMIT,
    assets: rows.map((r) => ({
      id: r.id, hostname: r.hostname, ipAddress: r.ipAddress, assetType: r.assetType, model: r.model,
      serialNumber: r.serialNumber, osVersion: r.osVersion, status: r.status, monitored: r.monitored, monitorStatus: r.monitorStatus,
      firmwareVsPrimary: firmwareVsPrimary(r, primaries),
    })),
  };
}

/** Recent runs, fleet-wide, for the Repository tab. */
export async function listRecentRuns(opts: { limit?: number; status?: string } = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  return prisma.firmwareUpgradeRun.findMany({
    where: opts.status ? { status: opts.status } : undefined,
    orderBy: { startedAt: "desc" },
    take: limit,
    select: {
      id: true, assetId: true, imageId: true, platform: true, fromVersion: true, toVersion: true, engine: true,
      status: true, stage: true, result: true, error: true, verifiedVersion: true, startedBy: true, startedAt: true, finishedAt: true,
      asset: { select: { hostname: true, ipAddress: true, model: true } },
    },
  });
}
