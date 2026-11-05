/**
 * src/utils/sleep.ts — THE promise-setTimeout helper.
 *
 * Four byte-identical private copies (arpPrimeService, winrm, queueService,
 * reclaimBloatedChunks) plus inline occurrences predated this module, and two
 * abortable copies (azureArcService.sleep, fortimanagerService.sleepWithAbort)
 * joined it on 2026-11-04 as the optional `signal`.
 *
 * Abort RESOLVES early, it never rejects: every caller is a retry / settle
 * wait that re-checks its own signal right after, and a rejection would turn
 * an operator's Cancel into an error path. Two different animals stay where
 * they are: `firmwareEngines/types.sleep`, which REJECTS with an AbortError
 * because the flash engines unwind on it, and the deliberately-synchronous
 * spin `sleepSync` in certInfo.
 */

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}
