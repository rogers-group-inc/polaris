/**
 * src/utils/capEff.ts — decode a Linux effective-capability bitmask.
 *
 * The Polaris Agent reports its /proc/self/status CapEff hex string on
 * heartbeat (ManagedAgent.reportedCapEff). Decoding lives server-side so
 * future capability changes never need an agent release — the agent ships
 * the raw mask, the server decides what it means.
 *
 * Only the two capabilities the ptrace tier grants are surfaced: the pair is
 * what Application Map connection attribution requires (CAP_DAC_READ_SEARCH
 * opens the 0500 /proc/<pid>/fd dir — a pure DAC check; CAP_SYS_PTRACE passes
 * the readlink's ptrace_may_access). A SYS_PTRACE-only mask is the prod
 * 2026-07-29 regression shape: the unit predates the DAC fix and the agent
 * silently collects zero connection rows.
 */

/** Linux capability bit numbers (include/uapi/linux/capability.h). */
const CAP_DAC_READ_SEARCH_BIT = 2;
const CAP_SYS_PTRACE_BIT = 19;

export interface DecodedCapEff {
  sysPtrace: boolean;
  dacReadSearch: boolean;
}

/**
 * Decode a CapEff hex string ("0000000000080000"-style, optional 0x prefix,
 * any case). Returns null for null/empty/unparseable input — callers treat
 * that as "not reported", never as "no capabilities".
 */
export function decodeCapEff(hex: string | null | undefined): DecodedCapEff | null {
  if (!hex) return null;
  const trimmed = hex.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{1,16}$/.test(trimmed)) return null;
  const mask = BigInt("0x" + trimmed);
  return {
    sysPtrace: (mask >> BigInt(CAP_SYS_PTRACE_BIT) & 1n) === 1n,
    dacReadSearch: (mask >> BigInt(CAP_DAC_READ_SEARCH_BIT) & 1n) === 1n,
  };
}
