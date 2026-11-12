/**
 * tests/unit/firmwareFileSweep.test.ts
 *
 * Business rule 158(b): the daily retention pass removes what a failed or
 * interrupted upload, delete or restore left in the firmware repository — an
 * image file no row points at, an upload abandoned in `.incoming`, and a row
 * whose bytes never landed. None of the three is reachable from the
 * Repository tab. Files are judged by age so work in flight is never touched,
 * and only names the service mints are ever considered.
 *
 * Prisma is an in-memory table; the files are real, in a temp directory
 * standing in for FIRMWARE_DIR.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { writeFileSync, existsSync, rmSync, readdirSync, utimesSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const dirs = await vi.hoisted(async () => {
  const os = await import("node:os");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-fwsweep-"));
  return { root, incoming: path.join(root, ".incoming") };
});

const h = vi.hoisted(() => {
  const state = { images: [] as Array<{ id: string; storagePath: string; uploadedAt: Date }>, failRead: false };
  return {
    state,
    prisma: {
      firmwareImage: {
        deleteMany: vi.fn(async ({ where }: { where: { storagePath: string; uploadedAt: { lt: Date } } }) => {
          const before = state.images.length;
          state.images = state.images.filter((r) => !(r.storagePath === where.storagePath && r.uploadedAt < where.uploadedAt.lt));
          return { count: before - state.images.length };
        }),
        findMany: vi.fn(async () => {
          if (state.failRead) throw new Error("database unavailable");
          return state.images.map((r) => ({ storagePath: r.storagePath }));
        }),
      },
    },
  };
});

vi.mock("../../src/utils/paths.js", () => ({ FIRMWARE_DIR: dirs.root, FIRMWARE_INCOMING_DIR: dirs.incoming, STATE_DIR: dirs.root }));
vi.mock("../../src/db.js", () => ({ prisma: h.prisma }));
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: vi.fn(async () => {}) }));
vi.mock("../../src/services/assetTypeService.js", () => ({ listAssetTypes: vi.fn(async () => []) }));

import { sweepFirmwareFiles, FIRMWARE_ORPHAN_GRACE_MS, FIRMWARE_INCOMING_GRACE_MS } from "../../src/services/firmwareRepositoryService.js";

const NOW = new Date();
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";

function put(dir: string, name: string, age: number) {
  const p = join(dir, name);
  writeFileSync(p, "firmware-bytes");
  const t = ago(age);
  utimesSync(p, t, t);
  return p;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.state.images = [];
  h.state.failRead = false;
  rmSync(dirs.root, { recursive: true, force: true });
  mkdirSync(dirs.incoming, { recursive: true });
});
afterAll(() => rmSync(dirs.root, { recursive: true, force: true }));

describe("rule 158(b): firmware repository leftovers", () => {
  it("removes an image file no row points at, and keeps every file a row does", async () => {
    h.state.images = [{ id: A, storagePath: `${A}.out`, uploadedAt: ago(10 * FIRMWARE_ORPHAN_GRACE_MS) }];
    const kept = put(dirs.root, `${A}.out`, 10 * FIRMWARE_ORPHAN_GRACE_MS);
    const orphan = put(dirs.root, `${B}.out`, 2 * FIRMWARE_ORPHAN_GRACE_MS);
    expect(await sweepFirmwareFiles(NOW)).toEqual({ files: 1, incoming: 0, rows: 0 });
    expect(existsSync(kept)).toBe(true);
    expect(existsSync(orphan)).toBe(false);
  });

  it("leaves a young unreferenced file: a registration renames the file before it stores the path", async () => {
    const fresh = put(dirs.root, `${B}.out`, FIRMWARE_ORPHAN_GRACE_MS / 2);
    expect(await sweepFirmwareFiles(NOW)).toEqual({ files: 0, incoming: 0, rows: 0 });
    expect(existsSync(fresh)).toBe(true);
  });

  it("never touches a name the service does not mint", async () => {
    const notes = put(dirs.root, "README.txt", 100 * FIRMWARE_ORPHAN_GRACE_MS);
    const odd = put(dirs.root, "FSW_108F-v7-build0000-FORTINET.out", 100 * FIRMWARE_ORPHAN_GRACE_MS);
    expect((await sweepFirmwareFiles(NOW)).files).toBe(0);
    expect(existsSync(notes)).toBe(true);
    expect(existsSync(odd)).toBe(true);
    expect(existsSync(dirs.incoming)).toBe(true); // the incoming directory itself is not a leftover
  });

  it("removes an upload abandoned in .incoming, and leaves one that may still be arriving", async () => {
    const dead = put(dirs.incoming, "firmware-upload-1-1", 2 * FIRMWARE_INCOMING_GRACE_MS);
    const live = put(dirs.incoming, "firmware-upload-2-2", FIRMWARE_INCOMING_GRACE_MS / 2);
    expect(await sweepFirmwareFiles(NOW)).toEqual({ files: 0, incoming: 1, rows: 0 });
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(live)).toBe(true);
  });

  it("deletes a row whose bytes never landed, and leaves one that is mid-registration", async () => {
    h.state.images = [
      { id: A, storagePath: "pending", uploadedAt: ago(2 * FIRMWARE_ORPHAN_GRACE_MS) },
      { id: B, storagePath: "pending", uploadedAt: ago(1000) },
      { id: C, storagePath: `${C}.out`, uploadedAt: ago(2 * FIRMWARE_ORPHAN_GRACE_MS) },
    ];
    put(dirs.root, `${C}.out`, 2 * FIRMWARE_ORPHAN_GRACE_MS);
    expect(await sweepFirmwareFiles(NOW)).toEqual({ files: 0, incoming: 0, rows: 1 });
    expect(h.state.images.map((r) => r.id)).toEqual([B, C]);
  });

  it("deletes nothing when the rows cannot be read", async () => {
    const f = put(dirs.root, `${B}.out`, 5 * FIRMWARE_ORPHAN_GRACE_MS);
    h.state.failRead = true;
    await expect(sweepFirmwareFiles(NOW)).rejects.toThrow("database unavailable");
    expect(existsSync(f)).toBe(true);
  });

  it("an install that never uploaded an image has no directory, and that is not an error", async () => {
    rmSync(dirs.root, { recursive: true, force: true });
    expect(await sweepFirmwareFiles(NOW)).toEqual({ files: 0, incoming: 0, rows: 0 });
    expect(readdirSync(join(dirs.root, "..")).length).toBeGreaterThan(0);
  });
});
