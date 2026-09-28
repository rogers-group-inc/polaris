// serviceInventoryService — current-state systemd unit / Windows service
// inventory writer. The service DIMENSION counterpart to the process inventory
// (persistAssetProcesses in monitoringService): units keyed by name, not by the
// backing program, so a service running as a shared runtime (e.g. a Spring Boot
// app as "java") is visible as itself and oneshot/exited units still appear.
//
// Single writer: the agent's `serviceInventory` sample stream. Full-replace per
// push (delete-then-insert in one $transaction, retryOnDeadlock), mirroring
// persistAssetProcesses / persistSdwanRules — a reader sees either the old set
// or the new set, never an empty intermediate. Agent-only (agentless SSH/WinRM
// does not resolve units).
import { randomUUID } from "node:crypto";

import { prisma } from "../db.js";
import { retryOnDeadlock } from "../utils/dbRetry.js";

export interface AssetServiceInput {
  unit:         string;
  platform:     "systemd" | "windows";
  displayName:  string | null;
  description:  string | null;
  loadState:    string | null;
  activeState:  string | null;
  subState:     string | null;
  enabledState: string | null;
  mainPid:      number | null;
  mainProcess:  string | null;
  memBytes:     bigint | null;
  /** Agent interval mean since its previous scrape; 100 = one core. */
  cpuPct:       number | null;
}

/**
 * The Polaris Agent's own service names — the Linux systemd unit and the Windows
 * SCM short name. Start/stop/restart of these is refused end-to-end: stopping
 * the agent would sever the control channel (and on Linux kill the collector
 * that reports this very inventory), so an operator could never bring it back
 * from the UI. The agent enforces the same rule locally as defense in depth.
 */
const AGENT_OWN_UNITS = new Set(["polaris-agent.service", "polaris-agent"]);

/** True when `unit` names the Polaris Agent's own service (self-control guard). */
export function isPolarisAgentOwnUnit(unit: string): boolean {
  return AGENT_OWN_UNITS.has(unit.trim().toLowerCase());
}

/**
 * True when the unit/service can be start/stop/restarted via the AgentCommand
 * queue. The agent's own service is never controllable (see AGENT_OWN_UNITS).
 * systemd: any loaded, non-masked unit (`systemctl start/stop/restart` targets
 * the unit regardless of current active state — needed to *start* a stopped
 * service). Windows: every SCM service is controllable via `net`/`sc`. A masked
 * or not-found systemd unit cannot be acted on.
 */
export function isServiceControllable(s: AssetServiceInput): boolean {
  if (isPolarisAgentOwnUnit(s.unit)) return false;
  if (s.platform === "windows") return true;
  const load = (s.loadState ?? "").toLowerCase();
  return load === "loaded";
}

/**
 * Current-state service inventory full-replace for one asset. An empty `rows`
 * is a valid delete-only scrape (a host that lost its agent / has no services).
 */
export async function persistAssetServices(
  assetId: string,
  rows: AssetServiceInput[],
): Promise<void> {
  const data = rows.map((r) => ({
    id:           randomUUID(),
    assetId,
    unit:         r.unit,
    platform:     r.platform,
    displayName:  r.displayName,
    description:  r.description,
    loadState:    r.loadState,
    activeState:  r.activeState,
    subState:     r.subState,
    enabledState: r.enabledState,
    mainPid:      r.mainPid,
    mainProcess:  r.mainProcess,
    memBytes:     r.memBytes,
    cpuPct:       r.cpuPct,
    controllable: isServiceControllable(r),
  }));
  await retryOnDeadlock(() =>
    prisma.$transaction([
      prisma.assetService.deleteMany({ where: { assetId } }),
      ...(data.length > 0
        ? [prisma.assetService.createMany({ data, skipDuplicates: true })]
        : []),
    ]),
  );
}
