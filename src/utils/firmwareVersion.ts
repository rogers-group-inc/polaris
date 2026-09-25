/**
 * src/utils/firmwareVersion.ts — firmware version and image identity for the
 * firmware repository (business rule 87).
 *
 * Pure. Ported from the fortiupgrade CLI (`src/version.ts`, `src/platform.ts`,
 * `src/firmware.ts` in rogers-group-inc/fortinet-updater), whose parsing rules
 * are the only ones bench-observed against real FortiSwitch / FortiAP images.
 *
 * Three facts this module decides, and nothing else:
 *
 *   1. What version a string names. Devices report `"7.6.5"`, `"v7.6.5"`,
 *      `"FP432F-v7.6.5-build1105"`, `"S108FF-v7-build1164"`; the repository
 *      stores four integer components and compares them component-wise,
 *      SKIPPING any component missing on either side. An indeterminate
 *      comparison is 0, which every caller treats as "not newer" — the
 *      failure mode is a missed upgrade, never a flash of an older image.
 *
 *   2. What a `.out` image is FOR. The first 512 bytes of a Fortinet image
 *      carry a header token like `S108FF-7.06-FW-build1164-260709-patch08`:
 *      the PLATFORM token is the device's serial-number prefix, `7.06` +
 *      `patch08` is 7.6.8, and FW / AP says which product line. That token is
 *      the safety gate — a repository image is offered to a device only when
 *      the token equals `platformFromSerial(Asset.serialNumber)`. A filename
 *      parse (`FSW_108F_FPOE-v7-build1164-FORTINET.out`) recovers the major
 *      and build but NOT a serial-prefix platform, so such an image is stored
 *      and never offered.
 *
 *   3. Which platform a DEVICE is: the first six characters of its serial,
 *      never `Asset.model` — an FMG-discovered switch can carry the literal
 *      model "FortiSwitch", and a model string is operator-editable.
 */

import { usableSerialOrNull } from "./serialNumber.js";

export interface FirmwareVersion {
  major: number;
  minor?: number;
  patch?: number;
  build?: number;
}

export type FirmwareFamily = "switch" | "ap";

export interface FirmwareImageIdentity {
  /** Serial-prefix platform token (`S108FF`, `FP231K`), or null when only a filename was readable. */
  platform: string | null;
  version: FirmwareVersion;
  parsedFrom: "header" | "filename";
  /** From the header's FW / AP marker; null on a filename parse. */
  family: FirmwareFamily | null;
  /** The raw token the parse keyed on — for the upload response and Events. */
  token: string;
}

// `v7.6.5`, `7.6.5 build1105`, `v7.6.5,build1105`, `FP432F-v7.6.5-build1105`.
const FULL_RE = /v?(\d+)\.(\d+)\.(\d+)(?:[,\s-]*build[\s-]?(\d+))?/i;
// `v7-build1164`, `v7.6-build1164` — the filename shape, which drops the patch.
const MAJOR_BUILD_RE = /v(\d+)(?:\.(\d+))?[,\s-]*build[\s-]?(\d+)/i;

/** Parse a version out of any string a device or an image name reports. */
export function parseFirmwareVersion(raw: string | null | undefined): FirmwareVersion | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;
  const full = FULL_RE.exec(s);
  if (full) {
    const v: FirmwareVersion = { major: Number(full[1]), minor: Number(full[2]), patch: Number(full[3]) };
    if (full[4] !== undefined) v.build = Number(full[4]);
    return v;
  }
  const mb = MAJOR_BUILD_RE.exec(s);
  if (mb) {
    const v: FirmwareVersion = { major: Number(mb[1]), build: Number(mb[3]) };
    if (mb[2] !== undefined) v.minor = Number(mb[2]);
    return v;
  }
  return null;
}

/**
 * Component-wise compare — major, minor, patch, build — skipping a component
 * that is missing on EITHER side. Two versions with nothing in common to
 * compare are equal (0). Relies on Fortinet build numbers rising monotonically
 * within a platform, which they do.
 */
export function compareFirmwareVersions(a: FirmwareVersion, b: FirmwareVersion): -1 | 0 | 1 {
  const pairs: Array<[number | undefined, number | undefined]> = [
    [a.major, b.major], [a.minor, b.minor], [a.patch, b.patch], [a.build, b.build],
  ];
  for (const [x, y] of pairs) {
    if (x === undefined || y === undefined) continue;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/**
 * True only when `candidate` is strictly newer than `current`. A device with no
 * readable version is never offered anything — "forward" needs a known "from".
 */
export function isStrictlyNewer(candidate: FirmwareVersion | null, current: FirmwareVersion | null): boolean {
  if (!candidate || !current) return false;
  return compareFirmwareVersions(candidate, current) === 1;
}

/** `7.6.8 build1164`, `7.6.8`, `7 build1164` — whatever components exist. */
export function formatFirmwareVersion(v: FirmwareVersion): string {
  let s = String(v.major);
  if (v.minor !== undefined) {
    s += `.${v.minor}`;
    if (v.patch !== undefined) s += `.${v.patch}`;
  }
  if (v.build !== undefined) s += ` build${v.build}`;
  return s;
}

// `S108FF-7.06-FW-build1164-260709-patch08`, `FP231K-7.06-AP-build1105-260519-patch05`.
const HEADER_RE = /([A-Z][0-9A-Z]{4,7})-(\d+)\.(\d{2})-(FW|AP)-build(\d+)-\d{6}(?:-patch(\d{2}))?/;
export const IMAGE_HEADER_BYTES = 512;

/** Identity from the image's own header (the first 512 bytes). */
export function parseFortinetImageHeader(head: Buffer): FirmwareImageIdentity | null {
  const text = head.subarray(0, IMAGE_HEADER_BYTES).toString("latin1");
  const m = HEADER_RE.exec(text);
  if (!m) return null;
  return {
    platform: m[1]!,
    version: { major: Number(m[2]), minor: Number(m[3]), patch: m[6] !== undefined ? Number(m[6]) : 0, build: Number(m[5]) },
    parsedFrom: "header",
    family: m[4] === "FW" ? "switch" : "ap",
    token: m[0],
  };
}

// The part of `FSW_108F_FPOE-v7-build1164-FORTINET.out` before the version.
const FILENAME_TOKEN_RE = /^(.+?)[-\s]v\d/;

/**
 * Identity from the file NAME. Recovers the major (+ build) only, and the token
 * is a marketing name (`FSW_108F_FPOE`), not a serial prefix — so `platform` is
 * null and the image is stored but never offered. The upload response says so.
 */
export function parseFortinetImageFilename(name: string): FirmwareImageIdentity | null {
  const base = name.replace(/\\/g, "/").split("/").pop() ?? name;
  const tok = FILENAME_TOKEN_RE.exec(base);
  const version = parseFirmwareVersion(base);
  if (!tok || !version) return null;
  return { platform: null, version, parsedFrom: "filename", family: null, token: tok[1]! };
}

/** Header first, filename as the fallback; null when neither says anything. */
export function identifyFirmwareImage(head: Buffer, filename: string): FirmwareImageIdentity | null {
  return parseFortinetImageHeader(head) ?? parseFortinetImageFilename(filename);
}

// ─── Devices ─────────────────────────────────────────────────────────────────

const PLATFORM_PREFIX_LENGTH = 6;
const FORTISWITCH_SERIAL_RE = /^(?:S\d{3}[A-Z]{2}|S[0-9A-Z]{5}|F[SR][0-9A-Z]{4})/;
const FORTIAP_SERIAL_RE = /^(?:FP|PU|PS)[0-9A-Z]{4}/;

/**
 * The platform token a device's serial names: its first six characters, upper
 * case. Null when the serial cannot identify a device at all (rule 84's
 * placeholders) or is too short to carry a prefix.
 */
export function platformFromSerial(serial: string | null | undefined): string | null {
  const s = usableSerialOrNull(serial);
  if (!s || s.length < PLATFORM_PREFIX_LENGTH) return null;
  return s.slice(0, PLATFORM_PREFIX_LENGTH).toUpperCase();
}

export function isFortiSwitchSerial(serial: string | null | undefined): boolean {
  const s = usableSerialOrNull(serial);
  return !!s && FORTISWITCH_SERIAL_RE.test(s.toUpperCase());
}

export function isFortiApSerial(serial: string | null | undefined): boolean {
  const s = usableSerialOrNull(serial);
  return !!s && FORTIAP_SERIAL_RE.test(s.toUpperCase());
}

/** Which Fortinet product line a serial belongs to, or null. */
export function firmwareFamilyForSerial(serial: string | null | undefined): FirmwareFamily | null {
  if (isFortiSwitchSerial(serial)) return "switch";
  if (isFortiApSerial(serial)) return "ap";
  return null;
}
