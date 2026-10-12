/**
 * src/utils/logPathGlob.ts — what an operator-typed log path glob may be.
 *
 * `AssetProcessConfig.logPathGlob` is delivered to a Polaris Agent, which runs
 * `filepath.Glob`, opens every match and ships each appended line back. The
 * agent runs as LocalSystem on Windows, root on macOS and a DynamicUser (with
 * optional CAP_DAC_READ_SEARCH) on Linux, so the glob is, in effect, "read this
 * file on that host". The old check was a length cap (scan finding F194): a
 * holder of only `assets:write` could point it at any file the agent could
 * open, or at `\\attacker\share\x` on Windows and make the host authenticate to
 * an SMB listener.
 *
 * Two layers, both here:
 *   - SHAPE (this file): an absolute LOCAL path — a POSIX path or a drive-letter
 *     path — with no network or device prefix, no `..` segment and no control
 *     character. A path that fails is refused on save and never sent to an agent.
 *   - AUTHORITY (the route): setting a NEW glob needs `assets=fullwrite`, the
 *     grant that already means "may deploy and drive agents" (business rule 43).
 *
 * Pure. Business rule 107.
 */

export const LOG_PATH_GLOB_MAX = 1024;

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Why `raw` is not an acceptable log path glob, or null when it is.
 * Empty / null are not errors — they mean "no glob".
 */
export function logPathGlobProblem(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw !== "string") return "The log path must be text.";
  if (raw.length > LOG_PATH_GLOB_MAX) return `The log path is longer than ${LOG_PATH_GLOB_MAX} characters.`;
  if (CONTROL_CHARS.test(raw)) return "The log path may not contain control characters.";

  // Network and device prefixes first: `\\host\share`, `//host/share`,
  // `\\.\PhysicalDrive0`, `\\?\C:\...`. A UNC path makes a Windows agent
  // authenticate to a remote server; a device path is not a log file.
  if (/^[\\/]{2}/.test(raw)) {
    return "The log path must be a local path, not a network share or device path.";
  }

  const isPosix = raw.startsWith("/");
  const isDrive = /^[A-Za-z]:[\\/]/.test(raw);
  if (!isPosix && !isDrive) {
    return "The log path must be absolute: start with / or a drive letter such as C:\\.";
  }

  // `..` anywhere as a whole segment walks out of whatever directory the
  // operator meant. Segments split on both separators: the agent may run on
  // either kind of host.
  if (raw.split(/[\\/]/).some((seg) => seg === "..")) {
    return "The log path may not contain .. segments.";
  }
  return null;
}

/** True when `raw` may be sent to an agent. */
export function isSafeLogPathGlob(raw: string | null | undefined): boolean {
  return logPathGlobProblem(raw) === null;
}
