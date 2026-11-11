/**
 * tests/unit/_monitoringServiceSource.ts — the monitoring service as ONE source,
 * for tests that assert on its text (a request string, a format constant, a call
 * count).
 *
 * monitoringService.ts is being split into src/services/monitoring/*.ts
 * (CQ-B061): each cluster moves verbatim and is re-exported, so imports never
 * notice — but a text assertion pinned to monitoringService.ts would break on
 * every move. Such a test reads `monitoringServiceSource()` instead: the service
 * file followed by every monitoring/*.ts module in name order.
 */

import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

const SERVICES = resolve(__dirname, "../../src/services");

/** monitoringService.ts plus every src/services/monitoring/*.ts, joined by a newline. */
export function monitoringServiceSource(): string {
  const dir = join(SERVICES, "monitoring");
  const parts = readdirSync(dir).filter((f) => f.endsWith(".ts")).sort().map((f) => readFileSync(join(dir, f), "utf8"));
  return [readFileSync(join(SERVICES, "monitoringService.ts"), "utf8"), ...parts].join("\n");
}
