/**
 * tests/unit/privateFiles.test.ts
 *
 * Business rule 117: files that hold the database are readable by the Polaris
 * account only. ensurePrivateDir = mkdir -p 0700 + (once per process per dir)
 * chmod the dir 0700 and its files 0600, never throwing on chmod;
 * makeFilePrivate = best-effort chmod 0600. node:fs is mocked so the modes
 * are asserted on every platform (chmod is a near no-op on Windows).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { join } from "node:path";

const fsMock = vi.hoisted(() => ({
  mkdirSync: vi.fn(),
  chmodSync: vi.fn(),
  readdirSync: vi.fn((): string[] => []),
  statSync: vi.fn((_p: string): { isFile: () => boolean } => ({ isFile: () => true })),
}));
vi.mock("node:fs", () => fsMock);

import { ensurePrivateDir, makeFilePrivate, PRIVATE_FILE_MODE } from "../../src/utils/privateFiles.js";

let n = 0;
const freshDir = () => `/data/backups-${++n}`;

beforeEach(() => {
  for (const f of Object.values(fsMock)) f.mockReset();
  fsMock.readdirSync.mockReturnValue([]);
  fsMock.statSync.mockImplementation(() => ({ isFile: () => true }));
});

describe("ensurePrivateDir", () => {
  it("creates the directory recursively as 0700", () => {
    const d = freshDir();
    ensurePrivateDir(d);
    expect(fsMock.mkdirSync).toHaveBeenCalledWith(d, { recursive: true, mode: 0o700 });
    expect(fsMock.chmodSync).toHaveBeenCalledWith(d, 0o700);
  });

  it("tightens existing files to 0600 but leaves subdirectories alone", () => {
    const d = freshDir();
    fsMock.readdirSync.mockReturnValue(["dump.sql.gz", "sub"]);
    fsMock.statSync.mockImplementation((p: string) => ({ isFile: () => !p.endsWith("sub") }));
    ensurePrivateDir(d);
    expect(fsMock.chmodSync).toHaveBeenCalledWith(join(d, "dump.sql.gz"), 0o600);
    expect(fsMock.chmodSync).not.toHaveBeenCalledWith(join(d, "sub"), expect.anything());
  });

  it("tightens only once per directory per process, but always mkdirs", () => {
    const d = freshDir();
    ensurePrivateDir(d);
    ensurePrivateDir(d);
    expect(fsMock.mkdirSync).toHaveBeenCalledTimes(2);
    expect(fsMock.chmodSync).toHaveBeenCalledTimes(1);
  });

  it("never throws on a chmod, stat or readdir failure", () => {
    const d = freshDir();
    fsMock.chmodSync.mockImplementation(() => { throw new Error("EPERM"); });
    fsMock.readdirSync.mockReturnValue(["a", "b"]);
    fsMock.statSync.mockImplementationOnce(() => { throw new Error("ENOENT"); });
    expect(() => ensurePrivateDir(d)).not.toThrow();
    const d2 = freshDir();
    fsMock.readdirSync.mockImplementation(() => { throw new Error("EACCES"); });
    expect(() => ensurePrivateDir(d2)).not.toThrow();
  });

  it("lets a mkdir failure surface", () => {
    fsMock.mkdirSync.mockImplementation(() => { throw new Error("EROFS"); });
    expect(() => ensurePrivateDir(freshDir())).toThrow("EROFS");
  });
});

describe("makeFilePrivate", () => {
  it("chmods to 0600", () => {
    expect(PRIVATE_FILE_MODE).toBe(0o600);
    makeFilePrivate("/data/x");
    expect(fsMock.chmodSync).toHaveBeenCalledWith("/data/x", 0o600);
  });

  it("swallows a chmod failure", () => {
    fsMock.chmodSync.mockImplementation(() => { throw new Error("ENOTSUP"); });
    expect(() => makeFilePrivate("/share/x")).not.toThrow();
  });
});
