/**
 * src/utils/osNormalize.ts
 *
 * Correct the Windows product name every discovery source gets wrong, and
 * label the build with the release operators actually speak in ("23H2").
 *
 * THE BUG THIS EXISTS FOR: Microsoft never updated
 * `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProductName` when Windows
 * 11 shipped. It still reads "Windows 10 Pro" on every Windows 11 client. That
 * key is what WMI's `Win32_OperatingSystem.Caption`, `systeminfo`, and most
 * inventory agents read — so it is NOT one broken integration, it is all of
 * them at once:
 *
 *   - AD          `operatingSystem`        → "Windows 10 Pro"
 *   - Entra/Intune `operatingSystem`       → "Windows" (no edition at all)
 *   - Polaris Agent (gopsutil host.Info)   → Platform from the same key
 *   - fortigate-endpoint OS fingerprint    → coarse, same family confusion
 *
 * The BUILD number, meanwhile, is always right, because it comes from
 * `CurrentBuild`/`CurrentBuildNumber` rather than the frozen display string.
 * So the build is the authority and the name is derived from it.
 *
 * TWO MECHANISMS, DELIBERATELY SEPARATE:
 *
 *   1. FAMILY (Windows 10 vs 11) comes from a THRESHOLD — build >= 22000.
 *      A threshold never goes stale, so a Windows build released after this
 *      code was written still gets the right family.
 *   2. RELEASE LABEL ("23H2") comes from a TABLE, which does go stale. An
 *      unknown build therefore keeps its raw osVersion untouched rather than
 *      being guessed at — the family fix still lands, only the pretty label
 *      is skipped.
 *
 * SERVER IS EXCLUDED ENTIRELY. Server's ProductName is correct already
 * ("Windows Server 2022 Standard"), and build 26100 is BOTH Windows 11 24H2
 * and Windows Server 2025 — so the threshold would happily relabel a 2025
 * server as "Windows 11". Any os string containing "server" is left alone.
 *
 * Applied at WRITE time in two places (both call this one function):
 *   - projectAssetFromSources (utils/assetProjection.ts) — so the projected
 *     pair and conflict proposals agree with the stored row. Normalizing only
 *     on the way to the DB would leave a permanent mismatch between the
 *     projected "Windows 10 Pro" and the stored "Windows 11 Pro".
 *   - the Asset write hooks in db.ts — the catch-all for the legacy inline
 *     writers (discoveryEngine's fortigate-endpoint path, the agents
 *     system-info route, conflictResolutionService, the assets PUT route).
 *
 * Storing the corrected value rather than transforming at render is what makes
 * the rest of the product agree: the Assets table's OS/Firmware filter + sort,
 * CSV/PDF export, `os`/`osVersion` tag-assignment criteria, maintenance-window
 * criteria, and automation scope conditions all read the stored columns. An
 * "os contains Windows 11" rule is only true if the column says so.
 */

/** Build at which the Windows CLIENT line became Windows 11. */
export const WINDOWS_11_MIN_BUILD = 22000;

/**
 * Windows CLIENT build → marketing release. Client only: the Server builds
 * that collide with client ones (26100 = 24H2 and Server 2025) are handled by
 * excluding Server strings before this table is consulted.
 *
 * Add a row when Microsoft ships a release. Omitting one is safe — an unknown
 * build keeps its raw osVersion and only the family is corrected.
 */
const CLIENT_RELEASES: Record<number, string> = {
  // Windows 10
  10240: "1507",
  10586: "1511",
  14393: "1607",
  15063: "1703",
  16299: "1709",
  17134: "1803",
  17763: "1809",
  18362: "1903",
  18363: "1909",
  19041: "2004",
  19042: "20H2",
  19043: "21H1",
  19044: "21H2",
  19045: "22H2",
  // Windows 11
  22000: "21H2",
  22621: "22H2",
  22631: "23H2",
  26100: "24H2",
  26200: "25H2",
};

/**
 * An osVersion this function already rewrote: "23H2 (10.0.22631.7219)" or
 * "1809 (10.0.17763)". Matched so a re-write of an already-normalized row
 * (every subsequent discovery cycle, and every db.ts-guarded write) is a
 * no-op instead of nesting the label — "23H2 (23H2 (10.0.22631.7219))".
 */
const RELEASE_PREFIX = /^(?:\d{4}|\d{2}H\d)\s*\(/;

export interface OsPair {
  os: string | null;
  osVersion: string | null;
}

/**
 * Is this os string a Windows CLIENT? Requires "windows" and rejects
 * "server" — see the header on why Server must not go through the threshold.
 */
function isWindowsClientName(os: string): boolean {
  const s = os.toLowerCase();
  return s.includes("windows") && !s.includes("server");
}

/**
 * Pull the NT build number out of whatever shape a source reports. Real
 * values seen in the wild, in the order tried:
 *
 *   "10.0.22631.7219"      Intune / Entra / Arc  → dotted, 4-part
 *   "10.0.22631"           Arc                   → dotted, 3-part
 *   "10.0 (22631)"         AD operatingSystemVersion
 *   "10.0.22631 Build 22631"  gopsutil on Windows (the agent)
 *   "22631"                bare build
 *
 * Returns null rather than guessing when nothing matches — the caller then
 * leaves the row entirely alone.
 */
export function windowsBuildFrom(...candidates: (string | null | undefined)[]): number | null {
  for (const raw of candidates) {
    if (!raw || typeof raw !== "string") continue;
    const s = raw.trim();
    if (!s) continue;

    // "10.0.22631[.7219]" — the NT major.minor prefix makes this unambiguous.
    const dotted = /\b10\.0\.(\d{4,6})\b/.exec(s);
    if (dotted) return Number(dotted[1]);

    // "… Build 22631" (gopsutil).
    const build = /\bbuild\s+(\d{4,6})\b/i.exec(s);
    if (build) return Number(build[1]);

    // "10.0 (22631)" (AD).
    const paren = /\((\d{4,6})\)/.exec(s);
    if (paren) return Number(paren[1]);

    // A bare build, but ONLY when the whole string is that number — a
    // 5-digit run inside a longer string is too weak a signal to act on.
    if (/^\d{5}$/.test(s)) return Number(s);
  }
  return null;
}

/**
 * Canonicalize AD's "10.0 (22631)" to "10.0.22631" so the label doesn't come
 * out with nested parens. Every other shape is preserved verbatim — the raw
 * build is what operators filter on, so it is never discarded.
 */
function canonicalizeRawVersion(raw: string): string {
  const m = /^(\d+\.\d+)\s*\((\d{4,6})\)$/.exec(raw.trim());
  return m ? `${m[1]}.${m[2]}` : raw.trim();
}

/**
 * Rewrite the os name to the family the build proves, leaving the edition
 * intact. Returns the input unchanged when the string carries no family token
 * to swap — inventing an edition is out of scope.
 */
function correctFamily(os: string, build: number): string {
  const family = build >= WINDOWS_11_MIN_BUILD ? "11" : "10";

  // "Windows 10 Pro" → "Windows 11 Pro"; "Microsoft Windows 10 Enterprise"
  // → "Microsoft Windows 11 Enterprise". Also self-correcting: a string that
  // already says the right family is rewritten to itself.
  if (/\bwindows\s+1[01]\b/i.test(os)) {
    return os.replace(/\b(windows)\s+1[01]\b/i, `$1 ${family}`);
  }

  // Intune and Entra collapse the whole thing to "Windows" with no version
  // at all. Naming the family is a strict improvement over that.
  if (/^windows$/i.test(os.trim())) {
    return `Windows ${family}`;
  }

  return os;
}

/**
 * Correct a (os, osVersion) pair in place-free fashion — returns a new pair.
 *
 * Non-Windows, Windows Server, and any pair whose build can't be determined
 * come back byte-identical, so this is safe to run over every Asset write
 * regardless of platform. Idempotent: running it on its own output is a no-op.
 */
export function normalizeWindowsOs(pair: OsPair): OsPair {
  const os = typeof pair.os === "string" ? pair.os : null;
  const osVersion = typeof pair.osVersion === "string" ? pair.osVersion : null;

  // The os name is the gate. Without it there's nothing to correct, and
  // treating a bare version string as Windows would be a guess.
  if (!os || !os.trim() || !isWindowsClientName(os)) return { os, osVersion };

  const build = windowsBuildFrom(osVersion, os);
  if (build === null) return { os, osVersion };

  const nextOs = correctFamily(os, build);

  let nextOsVersion = osVersion;
  const release = CLIENT_RELEASES[build];
  if (
    release &&
    osVersion &&
    osVersion.trim() &&
    // Already labeled by a previous pass.
    !RELEASE_PREFIX.test(osVersion.trim()) &&
    // A source that reports only the release ("23H2") gains nothing from
    // "23H2 (23H2)".
    osVersion.trim() !== release
  ) {
    nextOsVersion = `${release} (${canonicalizeRawVersion(osVersion)})`;
  }

  return { os: nextOs, osVersion: nextOsVersion };
}

/**
 * Prisma-shaped wrapper for the db.ts write hooks: mutate `data.os` /
 * `data.osVersion` in place, handling both the plain form ({os: "x"}) and
 * Prisma's nested form ({os: {set: "x"}}). Mirrors
 * normalizeManufacturerInData's contract.
 *
 * Only acts when the write stages `os` — the build is read from whatever
 * `osVersion` the same write carries (every real writer stages the pair
 * together: the projection, the agent system-info route, and each discovery
 * create). Deliberately does NOT read the existing row to find a missing
 * half: this runs on every Asset write including the monitor hot path, and a
 * point read there would cost 2000 extra queries per heavy cycle to fix a
 * case no writer produces.
 */
export function normalizeOsInData(data: any): void {
  if (!data || typeof data !== "object") return;
  if (!("os" in data)) return;

  const read = (v: unknown): { value: string | null; nested: boolean } => {
    if (typeof v === "string") return { value: v, nested: false };
    if (v && typeof v === "object" && "set" in (v as any) && typeof (v as any).set === "string") {
      return { value: (v as any).set, nested: true };
    }
    return { value: null, nested: false };
  };

  const osRead = read(data.os);
  if (osRead.value === null) return;
  const versionRead = "osVersion" in data ? read(data.osVersion) : { value: null, nested: false };

  const next = normalizeWindowsOs({ os: osRead.value, osVersion: versionRead.value });

  if (next.os !== osRead.value) {
    if (osRead.nested) data.os.set = next.os;
    else data.os = next.os;
  }
  if (versionRead.value !== null && next.osVersion !== versionRead.value) {
    if (versionRead.nested) data.osVersion.set = next.osVersion;
    else data.osVersion = next.osVersion;
  }
}
