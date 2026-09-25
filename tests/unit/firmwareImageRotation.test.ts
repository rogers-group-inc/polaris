/**
 * tests/unit/firmwareImageRotation.test.ts
 *
 * A model node keeps two images (business rule 87): a new upload becomes the
 * PRIMARY, the displaced primary becomes the BACKUP, and the displaced backup
 * is removed — row, file and an Event saying so. The operator may swap the
 * two; deleting the primary promotes the backup; purging a node removes both.
 * A rotation that would remove an image a run is flashing is refused whole:
 * nothing rotates, and the upload's temp file is gone either way.
 *
 * Prisma is mocked with an in-memory table; the files are real, in a temp
 * directory standing in for FIRMWARE_DIR.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs = vi.hoisted(() => {
  const os = require("node:os") as typeof import("node:os");
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-fw-"));
  fs.mkdirSync(path.join(root, ".incoming"), { recursive: true });
  return { root, incoming: path.join(root, ".incoming") };
});

const h = vi.hoisted(() => {
  type Img = Record<string, unknown> & { id: string; role: string; manufacturer: string; assetType: string; model: string; sha256: string; storagePath: string; versionLabel: string; uploadedAt: Date };
  const state = { images: [] as Img[], seq: 0, activeRunImageIds: new Set<string>(), assets: [] as Array<Record<string, unknown>> };
  const match = (row: Img, where: Record<string, unknown>) => Object.entries(where).every(([k, v]) => {
    if (v && typeof v === "object" && "in" in (v as object)) return ((v as { in: unknown[] }).in).includes(row[k]);
    return row[k] === v;
  });
  const model = {
    findMany: vi.fn(async (args?: { where?: Record<string, unknown> }) => state.images.filter((r) => !args?.where || match(r, args.where))),
    findFirst: vi.fn(async (args: { where: Record<string, unknown> }) => state.images.find((r) => match(r, args.where)) ?? null),
    findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => state.images.find((r) => match(r, where)) ?? null),
    count: vi.fn(async (args?: { where?: Record<string, unknown> }) => state.images.filter((r) => !args?.where || match(r, args.where)).length),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { const row = { id: `img-${++state.seq}`, uploadedAt: new Date(), ...data } as Img; state.images.push(row); return row; }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => { const row = state.images.find((r) => r.id === where.id)!; Object.assign(row, data); return row; }),
    delete: vi.fn(async ({ where }: { where: { id: string } }) => { state.images = state.images.filter((r) => r.id !== where.id); return {}; }),
    deleteMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => { state.images = state.images.filter((r) => !where.id.in.includes(r.id)); return {}; }),
  };
  return {
    state,
    model,
    logEvent: vi.fn(async () => {}),
    prisma: {
      firmwareImage: model,
      firmwareUpgradeRun: { count: vi.fn(async ({ where }: { where: { imageId: { in: string[] } } }) => where.imageId.in.filter((id) => state.activeRunImageIds.has(id)).length) },
      asset: { findMany: vi.fn(async () => state.assets), groupBy: vi.fn(async () => []) },
      firmwareCredentialBinding: { findMany: vi.fn(async () => []) },
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({ firmwareImage: model })),
    },
  };
});

vi.mock("../../src/utils/paths.js", () => ({ FIRMWARE_DIR: dirs.root, FIRMWARE_INCOMING_DIR: dirs.incoming, STATE_DIR: dirs.root }));
vi.mock("../../src/db.js", () => ({ prisma: h.prisma }));
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: h.logEvent }));
vi.mock("../../src/services/assetTypeService.js", () => ({ listAssetTypes: vi.fn(async () => [{ name: "switch", label: "Switch" }, { name: "access_point", label: "Access Point" }]) }));

import { registerUploadedImage, setPrimaryImage, deleteImage, purgeModelImages, getFirmwareTree } from "../../src/services/firmwareRepositoryService.js";

let n = 0;
function stageUpload(header: string, filler = "x"): { tmpPath: string; sizeBytes: number } {
  const p = join(dirs.incoming, `firmware-upload-${Date.now()}-${++n}`);
  const buf = Buffer.alloc(1024, filler);
  buf.write(header, 8, "latin1");
  writeFileSync(p, buf);
  return { tmpPath: p, sizeBytes: buf.length };
}
const NODE = { manufacturer: "Fortinet", assetType: "switch", model: "FortiSwitch S108FF" };
function upload(header: string, filler: string, name = "FSW_108F-v7-build0000-FORTINET.out") {
  return registerUploadedImage({ ...stageUpload(header, filler), originalName: name, ...NODE, actor: "tester" });
}
const events = () => h.logEvent.mock.calls.map((c) => c[0] as { action: string; message: string });
const filesOnDisk = () => readdirSync(dirs.root).filter((f) => f.endsWith(".out"));

beforeEach(() => {
  vi.clearAllMocks();
  h.state.images = [];
  h.state.activeRunImageIds = new Set();
  h.state.assets = [];
  for (const f of filesOnDisk()) rmSync(join(dirs.root, f), { force: true });
});
afterAll(() => rmSync(dirs.root, { recursive: true, force: true }));

describe("uploading into a model node", () => {
  it("the first image is the primary, its bytes land as <id>.out and the temp file is gone", async () => {
    const r = await upload("S108FF-7.06-FW-build1164-260709-patch08", "a");
    expect(r.image.role).toBe("primary");
    expect(r.image.platform).toBe("S108FF");
    expect(r.image.versionLabel).toBe("7.6.8 build1164");
    expect(r.rotatedOut).toBeNull();
    expect(r.demoted).toBeNull();
    expect(filesOnDisk()).toEqual([`${r.image.id}.out`]);
    expect(readdirSync(dirs.incoming)).toHaveLength(0);
  });

  it("the second becomes primary and the first the backup", async () => {
    const first = await upload("S108FF-7.06-FW-build1164-260709-patch08", "a");
    const second = await upload("S108FF-7.06-FW-build1200-260901-patch09", "b");
    expect(second.image.role).toBe("primary");
    expect(second.demoted).toEqual({ id: first.image.id, versionLabel: "7.6.8 build1164" });
    expect(h.state.images.find((i) => i.id === first.image.id)?.role).toBe("backup");
    expect(filesOnDisk().sort()).toEqual([`${first.image.id}.out`, `${second.image.id}.out`].sort());
  });

  it("the third removes the old backup — row, file, Event — and names it in the response", async () => {
    const first = await upload("S108FF-7.06-FW-build1164-260709-patch08", "a");
    await upload("S108FF-7.06-FW-build1200-260901-patch09", "b");
    const third = await upload("S108FF-7.06-FW-build1250-261001-patch10", "c");
    expect(third.rotatedOut).toEqual({ id: first.image.id, versionLabel: "7.6.8 build1164", filename: "FSW_108F-v7-build0000-FORTINET.out" });
    expect(h.state.images.map((i) => i.id)).not.toContain(first.image.id);
    expect(existsSync(join(dirs.root, `${first.image.id}.out`))).toBe(false);
    expect(h.state.images).toHaveLength(2);
    const deleted = events().filter((e) => e.action === "firmware.image_deleted");
    expect(deleted).toHaveLength(1);
    expect(deleted[0]!.message).toMatch(/a model keeps two images/);
  });

  it("refuses the third while a run is flashing the backup, and NOTHING rotates", async () => {
    const first = await upload("S108FF-7.06-FW-build1164-260709-patch08", "a");
    const second = await upload("S108FF-7.06-FW-build1200-260901-patch09", "b");
    h.state.activeRunImageIds.add(first.image.id);
    await expect(upload("S108FF-7.06-FW-build1250-261001-patch10", "c")).rejects.toMatchObject({ httpStatus: 409, message: expect.stringMatching(/being flashed right now/) });
    expect(h.state.images.map((i) => [i.id, i.role])).toEqual([[first.image.id, "backup"], [second.image.id, "primary"]]);
    expect(readdirSync(dirs.incoming)).toHaveLength(0);
  });

  it("refuses the same bytes twice, naming where they already live", async () => {
    await upload("S108FF-7.06-FW-build1164-260709-patch08", "a");
    await expect(upload("S108FF-7.06-FW-build1164-260709-patch08", "a")).rejects.toMatchObject({ httpStatus: 409, message: expect.stringMatching(/already in the repository under Fortinet › switch › FortiSwitch S108FF/) });
    expect(h.state.images).toHaveLength(1);
  });

  it("stores a filename-only image with no platform and says it will never be offered", async () => {
    const r = await upload("no header here", "z", "FSW_108F_FPOE-v7-build1164-FORTINET.out");
    expect(r.image.platform).toBeNull();
    expect(r.image.parsedFrom).toBe("filename");
    expect(r.warnings.join(" ")).toMatch(/will not be offered/);
  });

  it("refuses bytes that are neither a Fortinet image nor a versioned file name", async () => {
    await expect(upload("garbage", "g", "notes.bin")).rejects.toThrow(/not a recognisable firmware image/);
    expect(readdirSync(dirs.incoming)).toHaveLength(0);
  });

  it("warns when no asset under the model carries the image's serial prefix", async () => {
    h.state.assets = [{ manufacturer: "Fortinet", assetType: "switch", model: "FortiSwitch S108FF", serialNumber: "S548DFTF19000001" }];
    const r = await upload("S108FF-7.06-FW-build1164-260709-patch08", "a");
    expect(r.warnings.join(" ")).toMatch(/No asset under this model carries serial prefix S108FF \(they carry S548DF\)/);
  });
});

describe("make-primary, delete and purge", () => {
  it("swaps the roles", async () => {
    const first = await upload("S108FF-7.06-FW-build1164-260709-patch08", "a");
    const second = await upload("S108FF-7.06-FW-build1200-260901-patch09", "b");
    const promoted = await setPrimaryImage(first.image.id, "tester");
    expect(promoted.role).toBe("primary");
    expect(h.state.images.find((i) => i.id === second.image.id)?.role).toBe("backup");
    expect(events().some((e) => e.action === "firmware.image_promoted")).toBe(true);
    await expect(setPrimaryImage(first.image.id)).rejects.toThrow(/already the primary/);
  });

  it("deleting the primary promotes the backup; deleting a flashing image is refused", async () => {
    const first = await upload("S108FF-7.06-FW-build1164-260709-patch08", "a");
    const second = await upload("S108FF-7.06-FW-build1200-260901-patch09", "b");
    h.state.activeRunImageIds.add(second.image.id);
    await expect(deleteImage(second.image.id)).rejects.toMatchObject({ httpStatus: 409 });
    h.state.activeRunImageIds.clear();
    await deleteImage(second.image.id, "tester");
    expect(h.state.images).toHaveLength(1);
    expect(h.state.images[0]!.role).toBe("primary");
    expect(existsSync(join(dirs.root, `${second.image.id}.out`))).toBe(false);
    expect(existsSync(join(dirs.root, `${first.image.id}.out`))).toBe(true);
  });

  it("purge removes every image under the node and the tree stops showing it", async () => {
    await upload("S108FF-7.06-FW-build1164-260709-patch08", "a");
    await upload("S108FF-7.06-FW-build1200-260901-patch09", "b");
    let tree = await getFirmwareTree();
    const node = tree.manufacturers[0]!.assetTypes[0]!.models[0]!;
    expect(node.orphaned).toBe(true); // no assets carry the model
    expect(node.images).toHaveLength(2);
    expect(node.images[0]!.role).toBe("primary");
    expect(await purgeModelImages(NODE, "tester")).toEqual({ deleted: 2 });
    expect(filesOnDisk()).toHaveLength(0);
    tree = await getFirmwareTree();
    expect(tree.manufacturers).toHaveLength(0);
    expect(events().some((e) => e.action === "firmware.model_purged")).toBe(true);
  });
});
