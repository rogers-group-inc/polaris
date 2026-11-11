/**
 * tests/unit/_eventLogStub.ts — the shared stand-in for
 * src/services/eventLogService.ts (CQ-T009).
 *
 * eventLogService is half writers (logEvent, logEventsBatch, the discovery
 * audit loggers) and half PURE builders (buildChanges, computeFirmwareChange,
 * build*ChangedEvent, …) that a service under test needs to behave for real.
 * ~126 unit files mocked it by hand, most replacing only `logEvent`. This keeps
 * the real module and swaps only the writers for shared spies:
 *
 *   vi.mock("../../src/services/eventLogService.js", (orig) =>
 *     import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
 *   import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
 *   beforeEach(() => resetEventLogStub());
 *   expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({ action: "…" });
 *
 * The spies resolve (logEvent → undefined, logEventsBatch → the input count)
 * so fire-and-forget callers never see a rejected promise.
 */

import { vi } from "vitest";
import type { LogEventInput } from "../../src/services/eventLogService.js";

export const eventLog = {
  logEvent: vi.fn(async (_input: LogEventInput) => undefined),
  logEventsBatch: vi.fn(async (inputs: LogEventInput[]) => (Array.isArray(inputs) ? inputs.length : 0)),
  logDiscoveryAssetCreated: vi.fn((..._args: unknown[]) => undefined),
  logDiscoveryAssetUpdated: vi.fn((..._args: unknown[]) => undefined),
};

function applyDefaults(): void {
  eventLog.logEvent.mockImplementation(async () => undefined);
  eventLog.logEventsBatch.mockImplementation(async (inputs: LogEventInput[]) => (Array.isArray(inputs) ? inputs.length : 0));
  eventLog.logDiscoveryAssetCreated.mockImplementation(() => undefined);
  eventLog.logDiscoveryAssetUpdated.mockImplementation(() => undefined);
}

/** vi.mock factory body: the real eventLogService with its writers replaced by the shared spies. */
export async function withEventLogStubs(importOriginal: <T>() => Promise<T>): Promise<Record<string, unknown>> {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, ...eventLog };
}

/** Reset the writer spies' calls and restore their resolving defaults. */
export function resetEventLogStub(): void {
  for (const f of Object.values(eventLog)) f.mockReset();
  applyDefaults();
}
