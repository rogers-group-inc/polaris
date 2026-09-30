/**
 * src/services/firmwareEngines/types.ts — the contract between the firmware
 * upgrade service (orchestration: run rows, holds, Events) and an ENGINE
 * (protocol: how one product line takes a new image over its own HTTPS UI).
 *
 * An engine knows nothing about Prisma, Events or holds. It is handed a host,
 * a login, an image on disk and three callbacks, and it answers with one of
 * five results. Keeping it that narrow is what lets the protocol be tested
 * against a fake device on `node:http` without a database.
 *
 * Ported from the fortiupgrade CLI's `runner.ts` stages: preflight → transfer
 * / trigger → reboot → verify. Only the HTTPS-direct paths are here; the SSH +
 * SFTP/TFTP fallbacks that tool carries need inbound ports on the Polaris host
 * and were left out on purpose (business rule 87).
 */

export type FirmwareEngineKind = "fortiswitch-https" | "fortiap-https";

/**
 * "recovering" is the runner's, not an engine's: the device has answered the
 * engine over its web UI, and the run is holding its maintenance window open
 * until Polaris's OWN monitoring probe answers too (business rule 87).
 */
export type FirmwareRunStage = "preflight" | "staging" | "compat" | "deploying" | "rebooting" | "verifying" | "recovering";

export type FirmwareEngineOutcome = "upgraded" | "already-current" | "failed" | "unverified";

export interface FirmwareEngineTimeouts {
  /** One request/response, and the login probe (capped at probeMs). */
  commandMs: number;
  /** The whole image upload. */
  transferMs: number;
  /** How long to wait for the device to STOP answering after deploy. */
  rebootDownMs: number;
  /** How long to wait for it to answer again after it went down. */
  rebootUpMs: number;
  verifyRetries: number;
  verifyRetryDelayMs: number;
  /**
   * The RUNNER's, read by no engine: how long, after the engine is done, the
   * maintenance hold stays open waiting for the device's own monitoring probe
   * to answer, and how often that is checked. A device's web UI routinely
   * answers minutes before its SNMP agent does.
   */
  recoveryWaitMs: number;
  recoveryPollMs: number;
  /** FortiSwitch: the whole flash + reboot budget measured from deploy. */
  switchUpgradeMs: number;
  /** First contact with the device's UI — short, so "unreachable" is fast. */
  probeMs: number;
  /** Upload socket idle cap — bytes must keep moving. */
  uploadIdleMs: number;
  /** How often the reboot-wait polls. */
  heartbeatMs: number;
}

export const DEFAULT_FIRMWARE_TIMEOUTS: FirmwareEngineTimeouts = {
  commandMs: 15_000,
  transferMs: 900_000,
  rebootDownMs: 300_000,
  rebootUpMs: 900_000,
  verifyRetries: 5,
  verifyRetryDelayMs: 15_000,
  recoveryWaitMs: 600_000,
  recoveryPollMs: 15_000,
  switchUpgradeMs: 1_800_000,
  probeMs: 8_000,
  uploadIdleMs: 120_000,
  heartbeatMs: 30_000,
};

/** Percent-style progress a FortiSwitch reports while it flashes. */
/**
 * Flash progress as PERCENT, 0..100, one decimal. The FortiSwitch engine
 * converts from the device's 0..1 fractions when it reads them; the card and
 * the run row only ever see percent. `curStep` / `totStep` are the switch's
 * own counter, which has been seen pinned at 6/40 for a whole flash — logged,
 * never shown.
 */
export interface FirmwareProgress {
  erase?: number;
  write?: number;
  verify?: number;
  restart?: number;
  curStep?: number;
  totStep?: number;
  lastMsgAt?: string;
}

export interface FirmwareEngineContext {
  host: string;
  /** Default 443. */
  port?: number;
  /** "https" for a real device; "http" only so tests can run a fake device without certificates. */
  scheme?: "https" | "http";
  credential: { username: string; password: string };
  /** Absolute path of the `.out` on disk — streamed, never read whole. */
  imagePath: string;
  imageSize: number;
  image: { platform: string; versionLabel: string; version: { major: number; minor?: number; patch?: number; build?: number } };
  /** The asset's serial; the device's own report must match or the engine aborts. */
  expectedSerial: string | null;
  timeouts: FirmwareEngineTimeouts;
  onStage: (stage: FirmwareRunStage) => void;
  onProgress: (progress: FirmwareProgress) => void;
  onLog: (level: "info" | "warn" | "error", msg: string) => void;
  /** Cooperative cancel — checked between stages; nothing interrupts a flash mid-write. */
  signal?: AbortSignal;
}

export interface FirmwareEngineResult {
  outcome: FirmwareEngineOutcome;
  /** The version the device reported after it came back (or at preflight for already-current). */
  verifiedVersion?: string;
  deviceSerial?: string;
  error?: string;
}

export type FirmwareEngine = (ctx: FirmwareEngineContext) => Promise<FirmwareEngineResult>;

/** Thrown by an engine step; the runner turns it into `outcome: "failed"`. */
export class FirmwareEngineError extends Error {
  constructor(message: string, readonly stage: FirmwareRunStage) {
    super(message);
    this.name = "FirmwareEngineError";
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done(): void {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}
