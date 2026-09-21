/**
 * src/utils/fortiosEnvelope.ts — which half of a FortiOS REST response a field
 * lives in, kept pure so it unit-tests against captured device payloads with no
 * network and no database.
 *
 * ── The mistake this exists to stop ───────────────────────────────────────────
 * A FortiOS REST reply is an ENVELOPE around a payload:
 *
 *   {
 *     "http_method": "GET",
 *     "results":  { "model_name": "FortiGate", "model": "FGT61F",
 *                   "hostname": "HUB1-a", "log_disk_status": "available" },
 *     "vdom": "root", "path": "system", "name": "status", "status": "success",
 *     "serial": "FGT61FTK23009069", "version": "v7.6.7", "build": 3704
 *   }
 *
 * The identity of the box — `serial`, `version`, `build` — is on the ENVELOPE.
 * Only `hostname` and the model fields are inside `results`. Every transport in
 * this codebase unwraps to `results` before returning (`fgRequest` ends with
 * `body?.results ?? body`, and `fmgProxyRest` with `inner?.results ?? inner`),
 * which is right for the ~30 callers that want the payload and silently wrong
 * for the handful that want the box's identity.
 *
 * What that cost, proven against lab hardware on 2026-09-21: a
 * standalone-FortiGate discovery recorded an EMPTY chassis serial and an EMPTY
 * osVersion for every gate, on every run, and never detected an HA cluster —
 * `fgtChainHa` falls its caller serial back to the device serial, so with that
 * empty its `if (callerSerial && members.length)` guard could not pass. A
 * two-member active-passive pair that `ha-peer` reported correctly was stamped
 * `haMode: "standalone"`. Nothing errored: every field degraded to empty or to
 * a fallback, and the asset still looked populated because hostname and model
 * DO survive the unwrap. The serial mattering is not cosmetic — business rule
 * 41 gates subnet identity on it, and `fortinetParentKey` resolves a managed
 * switch's or AP's parent by `controllerSerial` FIRST.
 *
 * ── Why these readers are tolerant of both shapes ─────────────────────────────
 * Each one accepts the full envelope OR an already-unwrapped payload, and looks
 * for every field in both halves. Three reasons, all of them things that have
 * actually happened here: the FortiManager proxy and the direct REST client
 * unwrap at different layers; FortiOS moves fields between the halves across
 * builds and endpoints; and a caller that forgets `envelope: true` should lose
 * a field rather than crash. Absent is always `undefined`, never a placeholder,
 * so a caller can tell "the device did not say" from "the device said empty".
 */

/** The FortiOS REST envelope, as much of it as anything here reads. */
export interface FortiOsEnvelope<T = unknown> {
  results?: T;
  serial?: string;
  version?: string;
  build?: number;
  status?: string;
  vdom?: string;
}

/** Read a string field from the envelope, falling back to the payload. */
function readString(body: unknown, key: string): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const outer = body as Record<string, unknown>;
  const direct = outer[key];
  if (typeof direct === "string" && direct.trim() !== "") return direct.trim();
  const inner = outer.results;
  if (inner && typeof inner === "object" && !Array.isArray(inner)) {
    const nested = (inner as Record<string, unknown>)[key];
    if (typeof nested === "string" && nested.trim() !== "") return nested.trim();
  }
  return undefined;
}

/** Read a numeric field the same way. */
function readNumber(body: unknown, key: string): number | undefined {
  if (!body || typeof body !== "object") return undefined;
  const outer = body as Record<string, unknown>;
  const direct = outer[key];
  if (typeof direct === "number" && Number.isFinite(direct)) return direct;
  const inner = outer.results;
  if (inner && typeof inner === "object" && !Array.isArray(inner)) {
    const nested = (inner as Record<string, unknown>)[key];
    if (typeof nested === "number" && Number.isFinite(nested)) return nested;
  }
  return undefined;
}

/** What `/api/v2/monitor/system/status` says about the box that answered. */
export interface FortiOsSystemStatus {
  /** The gate's configured hostname. Inside `results`. */
  hostname?: string;
  /** The chassis serial. On the ENVELOPE — this is the field that was lost. */
  serial?: string;
  /** FortiOS version, e.g. "v7.6.7". On the ENVELOPE. */
  version?: string;
  /** FortiOS build number, e.g. 3704. On the ENVELOPE. */
  build?: number;
  /** Short model, e.g. "FGT61F". Inside `results`. */
  model?: string;
  /** Long model name, e.g. "FortiGate". Inside `results`. */
  modelName?: string;
}

/**
 * Read a system/status reply into the six fields discovery and the connection
 * test want, from whichever half of the response each one is in.
 */
export function readSystemStatus(body: unknown): FortiOsSystemStatus {
  return {
    hostname: readString(body, "hostname"),
    serial: readString(body, "serial"),
    version: readString(body, "version"),
    build: readNumber(body, "build"),
    model: readString(body, "model"),
    modelName: readString(body, "model_name"),
  };
}

/** One member of an HA cluster, as `ha-peer` reports it. */
export interface FortiOsHaMember {
  serial: string;
  hostname?: string;
  priority?: number;
  /** FortiOS marks the active unit with `master` and/or `primary`. */
  isPrimary: boolean;
}

export interface FortiOsHaPeers {
  /**
   * The serial of the unit that ANSWERED. Read from the envelope, then from a
   * member the device itself flagged primary, then from the caller's fallback.
   *
   * The middle step is what makes this robust rather than merely fixed: the
   * REST endpoint is only ever reached through the cluster address, which
   * routes to whichever member is currently active, so the member carrying
   * `primary: true` IS the caller. That holds even on a build whose envelope
   * omits the serial.
   */
  callerSerial: string;
  /** Every member the device listed, the caller included. */
  members: FortiOsHaMember[];
}

/**
 * Read an `ha-peer` reply.
 *
 * Accepts the full envelope, an already-unwrapped `results` array, or a bare
 * array — all three have been seen across FortiOS builds and the two transports.
 * A non-HA gate answers with an empty list or a 404, so `members.length < 2` is
 * the standalone signal and the caller decides what to do with it.
 */
export function readHaPeers(body: unknown, fallbackSerial?: string): FortiOsHaPeers {
  const rows: unknown[] = Array.isArray(body)
    ? body
    : Array.isArray((body as { results?: unknown } | null)?.results)
      ? ((body as { results: unknown[] }).results)
      : [];

  const members: FortiOsHaMember[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const serial = String(r.serial_no ?? r.serial ?? "").trim();
    if (!serial) continue;
    const hostname = typeof r.hostname === "string" && r.hostname.trim() !== "" ? r.hostname.trim() : undefined;
    const priority = typeof r.priority === "number" && Number.isFinite(r.priority) ? r.priority : undefined;
    members.push({ serial, hostname, priority, isPrimary: r.master === true || r.primary === true });
  }

  const fromEnvelope = Array.isArray(body) ? undefined : readString(body, "serial") ?? readString(body, "serial_no");
  const fromFlaggedMember = members.find((m) => m.isPrimary)?.serial;
  const callerSerial = (fromEnvelope || fromFlaggedMember || fallbackSerial || "").trim();

  return { callerSerial, members };
}
