/**
 * Version-string parsing for the platform stack.
 *
 * Pure functions only — no I/O, no imports from services — so the parsing is
 * unit-testable without a database or a host that happens to have Go installed.
 * The probes that *call* these live in the platform lifecycle service; the
 * lifecycle facts they get graded against live in src/data/platformEol.json.
 *
 * Every parser returns null rather than throwing on unrecognized input. A host
 * with a vendored or development toolchain must degrade to "unknown", never
 * break the caller — refusing to work because a version string was surprising
 * is a worse failure than the one being prevented.
 */

/** A version cut to the granularity a technology's lifecycle is tracked at. */
export type TrackGranularity = "major" | "major.minor";

/**
 * Cut a version to a lifecycle track. Vendors disagree about granularity:
 * Node and PostgreSQL retire whole majors, Go and nginx retire minors.
 *
 *   deriveTrack("20.19.0", "major")       -> "20"
 *   deriveTrack("1.22.7",  "major.minor") -> "1.22"
 */
export function deriveTrack(version: string, granularity: TrackGranularity): string | null {
  const m = String(version).trim().match(/^(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  if (granularity === "major") return m[1];
  return m[2] === undefined ? m[1] : `${m[1]}.${m[2]}`;
}

/**
 * Numeric, component-wise track comparison. Returns <0, 0, >0.
 *
 * String comparison is wrong here and wrong in a way that only shows up later:
 * "1.9" > "1.10" lexically, so a naive compare would report a host on nginx
 * 1.10 as below a 1.9 floor.
 */
export function compareTracks(a: string, b: string): number {
  const pa = String(a).split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Parse the version out of `go version` output.
 *
 * Accepts every shape the toolchain emits:
 *   "go version go1.22.7 linux/amd64"  -> "1.22.7"
 *   "go version go1.24rc1 darwin/arm64" -> "1.24"
 *   "go version devel go1.25-abc123 …"  -> "1.25"
 *   "go1.22"                            -> "1.22"
 *
 * Release candidates and devel builds deliberately lose their suffix: the
 * lifecycle question is which minor line you are on, and go1.24rc1 is on 1.24.
 */
export function parseGoVersion(raw: string): string | null {
  const m = String(raw).match(/go(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  return m[3] === undefined ? `${m[1]}.${m[2]}` : `${m[1]}.${m[2]}.${m[3]}`;
}

/**
 * The Node major Polaris supports. Mirrors `engines.node` in package.json,
 * which npm only warns about, and is one of 23 Node declaration sites — see
 * .claude/skills/polaris-tech-lifecycle/references/version-pin-inventory.md.
 */
export const NODE_MINIMUM_MAJOR = "20";

/**
 * The running Node major, from the process itself.
 *
 * Nothing in the app read this before: `process.version` and
 * `process.versions` appear nowhere outside generated code, so "which Node am
 * I actually on" was unanswerable from the UI.
 */
export function runningNodeTrack(): string | null {
  return deriveTrack(process.versions.node, "major");
}

/**
 * Emit an advisory when the running Node major is below `minimum`. Calls
 * `warn` at most once and returns whether it did.
 *
 * Takes the sink as a parameter so this stays a pure-ish, testable function
 * and so the caller at boot can write to the console before the logger exists.
 */
export function checkNodeVersionAtBoot(minimum: string, warn: (msg: string) => void): boolean {
  const track = runningNodeTrack();
  if (!track || compareTracks(track, minimum) >= 0) return false;
  warn(
    `Polaris is running on Node ${process.versions.node}, below the supported minimum of Node ${minimum}. ` +
      `This combination is untested — upgrade the runtime on this host. ` +
      `See the Platform Lifecycle card under Server Settings -> Maintenance.`,
  );
  return true;
}
