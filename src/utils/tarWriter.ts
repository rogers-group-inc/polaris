/**
 * src/utils/tarWriter.ts — build a small ustar archive in memory.
 *
 * The HA node bundle is a handful of text files (rendered Patroni and etcd
 * config, PEM certificates, an SSH keypair, .env) that a bootstrap script
 * unpacks with `tar xzf`. Three ways to produce that, and this is the third:
 *
 *   - A tar npm package: a new dependency, and a transitive tree, for ten
 *     files that never exceed a few kilobytes.
 *   - Shelling out to `tar`: works on the RHEL host but not in a unit test on
 *     Windows, and turns "did we build the archive correctly" into an
 *     integration test that needs a temp directory and a system binary.
 *   - This: about eighty lines of a format that has not changed since 1988,
 *     deterministic, and asserted byte-for-byte in tests.
 *
 * Scope is deliberately narrow — regular files only, no directories (tar
 * creates parents implicitly), no symlinks, no long-name (PAX/GNU) extensions.
 * Paths longer than 99 bytes are refused rather than silently truncated: a
 * bundle that unpacks to the wrong filename would install a certificate
 * somewhere nothing reads it.
 */

const BLOCK_SIZE = 512;
/** ustar stores the name in a 100-byte field, NUL-terminated. */
const MAX_NAME_BYTES = 99;

export interface TarEntry {
  /** Relative path inside the archive, e.g. "etcd/ca.crt". */
  name: string;
  /** File contents. A string is encoded as UTF-8. */
  data: string | Buffer;
  /**
   * POSIX permission bits. Defaults to 0o600: everything in an HA bundle is
   * either a private key or a config file naming one, so the safe default is
   * owner-only and the caller opts a file UP to 0o644.
   */
  mode?: number;
  /** Modification time; defaults to the epoch so archives are reproducible. */
  mtime?: Date;
}

function octal(value: number, width: number): string {
  // ustar numeric fields are octal, NUL-terminated, zero-padded to width-1.
  const digits = Math.max(0, Math.trunc(value)).toString(8);
  if (digits.length > width - 1) {
    throw new Error(`tar: value ${value} does not fit in ${width} octal bytes`);
  }
  return digits.padStart(width - 1, "0") + "\0";
}

function buildHeader(entry: TarEntry, size: number): Buffer {
  const header = Buffer.alloc(BLOCK_SIZE);
  const name = Buffer.from(entry.name, "utf8");
  if (name.length > MAX_NAME_BYTES) {
    // Refuse rather than truncate: see the header note.
    throw new Error(`tar: entry name too long (${name.length} bytes, max ${MAX_NAME_BYTES}): ${entry.name}`);
  }
  if (entry.name.startsWith("/") || entry.name.includes("..")) {
    // An absolute or climbing path in an archive an operator unpacks as root
    // is a way to write outside the extraction directory.
    throw new Error(`tar: entry name must be relative and must not contain "..": ${entry.name}`);
  }

  name.copy(header, 0);
  header.write(octal(entry.mode ?? 0o600, 8), 100, "ascii");        // mode
  header.write(octal(0, 8), 108, "ascii");                           // uid  — root on extract
  header.write(octal(0, 8), 116, "ascii");                           // gid
  header.write(octal(size, 12), 124, "ascii");                       // size
  header.write(octal(Math.floor((entry.mtime ?? new Date(0)).getTime() / 1000), 12), 136, "ascii");
  header.write("        ", 148, "ascii");                            // checksum: spaces while summing
  header.write("0", 156, "ascii");                                   // typeflag: regular file
  header.write("ustar\0", 257, "ascii");                             // magic
  header.write("00", 263, "ascii");                                  // version
  header.write("root", 265, "ascii");                                // uname
  header.write("root", 297, "ascii");                                // gname

  let sum = 0;
  for (const byte of header) sum += byte;
  // Six octal digits, NUL, space — the historical encoding every tar accepts.
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  return header;
}

function pad(size: number): Buffer {
  const remainder = size % BLOCK_SIZE;
  return remainder === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK_SIZE - remainder);
}

/**
 * Build an uncompressed tar archive.
 *
 * Deterministic: the same entries in the same order produce identical bytes,
 * which is what lets a test assert on the archive rather than on a mock.
 */
export function buildTar(entries: TarEntry[]): Buffer {
  if (!entries.length) throw new Error("tar: refusing to build an empty archive");
  const seen = new Set<string>();
  const parts: Buffer[] = [];
  for (const entry of entries) {
    if (seen.has(entry.name)) {
      // Two entries with one name unpack in an order the caller did not
      // choose; the last one silently wins.
      throw new Error(`tar: duplicate entry name: ${entry.name}`);
    }
    seen.add(entry.name);
    const data = typeof entry.data === "string" ? Buffer.from(entry.data, "utf8") : entry.data;
    parts.push(buildHeader(entry, data.length), data, pad(data.length));
  }
  // Two zero blocks mark the end of the archive.
  parts.push(Buffer.alloc(BLOCK_SIZE * 2));
  return Buffer.concat(parts);
}

/** One entry's metadata as read back out of an archive. */
export interface ListedEntry {
  name: string;
  size: number;
  mode: number;
}

/**
 * List an archive's entries.
 *
 * Exists for the tests and for verifying a bundle before it is handed over —
 * not a general-purpose extractor. Stops at the first zero block.
 */
export function listTar(archive: Buffer): ListedEntry[] {
  const out: ListedEntry[] = [];
  let offset = 0;
  while (offset + BLOCK_SIZE <= archive.length) {
    const header = archive.subarray(offset, offset + BLOCK_SIZE);
    if (header.every((b) => b === 0)) break;
    const nameEnd = header.indexOf(0, 0);
    const name = header.subarray(0, nameEnd === -1 ? 100 : Math.min(nameEnd, 100)).toString("utf8");
    const readOctal = (start: number, width: number): number => {
      const raw = header.subarray(start, start + width).toString("ascii").replace(/\0.*$/, "").trim();
      return raw ? parseInt(raw, 8) : 0;
    };
    const size = readOctal(124, 12);
    out.push({ name, size, mode: readOctal(100, 8) });
    offset += BLOCK_SIZE + size + (size % BLOCK_SIZE === 0 ? 0 : BLOCK_SIZE - (size % BLOCK_SIZE));
  }
  return out;
}

/** Read one file's contents back out of an archive. Null when absent. */
export function readTarEntry(archive: Buffer, name: string): Buffer | null {
  let offset = 0;
  while (offset + BLOCK_SIZE <= archive.length) {
    const header = archive.subarray(offset, offset + BLOCK_SIZE);
    if (header.every((b) => b === 0)) return null;
    const nameEnd = header.indexOf(0, 0);
    const entryName = header.subarray(0, nameEnd === -1 ? 100 : Math.min(nameEnd, 100)).toString("utf8");
    const sizeRaw = header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim();
    const size = sizeRaw ? parseInt(sizeRaw, 8) : 0;
    const dataStart = offset + BLOCK_SIZE;
    if (entryName === name) return archive.subarray(dataStart, dataStart + size);
    offset = dataStart + size + (size % BLOCK_SIZE === 0 ? 0 : BLOCK_SIZE - (size % BLOCK_SIZE));
  }
  return null;
}
