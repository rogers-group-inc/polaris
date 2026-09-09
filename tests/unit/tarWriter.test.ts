/**
 * tests/unit/tarWriter.test.ts
 *
 * The HA node bundle is unpacked by `tar xzf` on a host an operator is
 * standing in front of, so a malformed archive is discovered at the worst
 * possible moment. The checksum, the block padding and the end-of-archive
 * marker are asserted directly, and the refusals matter as much as the happy
 * path: a truncated filename would install a certificate somewhere nothing
 * reads it, and a climbing path would write outside the extraction directory
 * as root.
 */

import { describe, it, expect } from "vitest";
import { gunzipSync, gzipSync } from "node:zlib";
import { buildTar, listTar, readTarEntry } from "../../src/utils/tarWriter.js";

const BLOCK = 512;

describe("buildTar", () => {
  it("emits a 512-byte header, padded data, and two zero blocks", () => {
    const tar = buildTar([{ name: "a.txt", data: "hello" }]);
    // header + one padded data block + two end blocks
    expect(tar.length).toBe(BLOCK * 4);
    expect(tar.length % BLOCK).toBe(0);
    const tail = tar.subarray(tar.length - BLOCK * 2);
    expect(tail.every((b) => b === 0)).toBe(true);
  });

  it("writes a header checksum that matches the header bytes", () => {
    const tar = buildTar([{ name: "a.txt", data: "hello" }]);
    const header = tar.subarray(0, BLOCK);
    const stored = parseInt(header.subarray(148, 154).toString("ascii"), 8);
    // Recompute with the checksum field blanked to spaces, as the format says.
    const copy = Buffer.from(header);
    copy.write("        ", 148, "ascii");
    let sum = 0;
    for (const b of copy) sum += b;
    expect(stored).toBe(sum);
  });

  it("identifies itself as ustar with a regular-file typeflag", () => {
    const header = buildTar([{ name: "a.txt", data: "x" }]).subarray(0, BLOCK);
    expect(header.subarray(257, 262).toString("ascii")).toBe("ustar");
    expect(header.subarray(156, 157).toString("ascii")).toBe("0");
  });

  it("is byte-for-byte reproducible", () => {
    const entries = [{ name: "a", data: "one" }, { name: "b", data: "two" }];
    expect(buildTar(entries).equals(buildTar(entries))).toBe(true);
  });

  it("defaults to owner-only permissions and honours an explicit mode", () => {
    const tar = buildTar([
      { name: "secret.key", data: "k" },
      { name: "public.crt", data: "c", mode: 0o644 },
    ]);
    const listed = listTar(tar);
    expect(listed.find((e) => e.name === "secret.key")!.mode).toBe(0o600);
    expect(listed.find((e) => e.name === "public.crt")!.mode).toBe(0o644);
  });

  it("pads a file that exactly fills a block without adding a spurious one", () => {
    const exact = "x".repeat(BLOCK);
    const tar = buildTar([{ name: "a", data: exact }]);
    // header + exactly one data block + two end blocks
    expect(tar.length).toBe(BLOCK * 4);
  });

  it("round-trips through gzip, which is how the bundle ships", () => {
    const tar = buildTar([{ name: "patroni.yml", data: "scope: polaris\n" }]);
    expect(gunzipSync(gzipSync(tar)).equals(tar)).toBe(true);
  });
});

describe("buildTar refusals", () => {
  it("refuses an empty archive", () => {
    expect(() => buildTar([])).toThrow(/empty archive/);
  });

  it("refuses a name too long for the ustar field rather than truncating it", () => {
    expect(() => buildTar([{ name: "a".repeat(100), data: "x" }])).toThrow(/too long/);
    // 99 bytes is the documented maximum and must still work.
    expect(() => buildTar([{ name: "a".repeat(99), data: "x" }])).not.toThrow();
  });

  it("refuses an absolute or climbing path", () => {
    expect(() => buildTar([{ name: "/etc/passwd", data: "x" }])).toThrow(/relative/);
    expect(() => buildTar([{ name: "../outside", data: "x" }])).toThrow(/relative/);
    expect(() => buildTar([{ name: "ok/../../outside", data: "x" }])).toThrow(/relative/);
  });

  it("refuses two entries with the same name", () => {
    expect(() => buildTar([
      { name: "dup", data: "one" },
      { name: "dup", data: "two" },
    ])).toThrow(/duplicate/);
  });
});

describe("listTar and readTarEntry", () => {
  const tar = buildTar([
    { name: "etcd/ca.crt", data: "CERT", mode: 0o644 },
    { name: "etcd/node.key", data: "KEY" },
    { name: "patroni.yml", data: "scope: polaris\n", mode: 0o600 },
  ]);

  it("lists every entry in order with its size", () => {
    expect(listTar(tar).map((e) => e.name)).toEqual(["etcd/ca.crt", "etcd/node.key", "patroni.yml"]);
    expect(listTar(tar).find((e) => e.name === "etcd/ca.crt")!.size).toBe(4);
  });

  it("stops at the end-of-archive marker rather than reading padding as entries", () => {
    expect(listTar(tar).length).toBe(3);
  });

  it("reads a named entry's exact contents", () => {
    expect(readTarEntry(tar, "patroni.yml")!.toString("utf8")).toBe("scope: polaris\n");
    expect(readTarEntry(tar, "etcd/node.key")!.toString("utf8")).toBe("KEY");
  });

  it("returns null for an entry that is not present", () => {
    expect(readTarEntry(tar, "nope")).toBeNull();
  });

  it("handles nested paths, which directories in the archive do not require", () => {
    // No directory entries were written; tar creates parents on extract.
    expect(listTar(tar).every((e) => !e.name.endsWith("/"))).toBe(true);
  });

  it("survives a multi-block file", () => {
    const big = "y".repeat(BLOCK * 3 + 17);
    const t = buildTar([{ name: "first", data: "a" }, { name: "big", data: big }, { name: "last", data: "z" }]);
    expect(readTarEntry(t, "big")!.toString("utf8")).toBe(big);
    expect(readTarEntry(t, "last")!.toString("utf8")).toBe("z");
    expect(listTar(t).map((e) => e.name)).toEqual(["first", "big", "last"]);
  });
});
