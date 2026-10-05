// serviceInventoryService — current-state systemd unit / Windows service
// inventory writer. The service DIMENSION counterpart to the process inventory
// (persistAssetProcesses in monitoringService): units keyed by name, not by the
// backing program, so a service running as a shared runtime (e.g. a Spring Boot
// app as "java") is visible as itself and oneshot/exited units still appear.
//
// Single writer: the agent's `serviceInventory` sample stream. The whole list
// arrives per push but is written as a DELTA in one transaction
// (utils/inventoryDelta, retryOnDeadlock), like persistAssetProcesses — a
// reader sees either the old set or the new set, never an empty intermediate.
// Agent-only (agentless SSH/WinRM does not resolve units).
import { randomUUID } from "node:crypto";

import { prisma } from "../db.js";
import { retryOnDeadlock } from "../utils/dbRetry.js";
import { diffInventory, normalizeBytes, normalizeCpuPct, sameInventoryRow } from "../utils/inventoryDelta.js";

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

/** The stored columns a scrape can change. memBytes / cpuPct are compared
 *  through the dead band (sameInventoryRow); the rest exactly. */
const SERVICE_FIELDS = [
  "platform", "displayName", "description", "loadState", "activeState", "subState",
  "enabledState", "mainPid", "mainProcess", "memBytes", "cpuPct", "controllable",
] as const;
const SERVICE_EXACT_FIELDS = SERVICE_FIELDS.filter((f) => f !== "memBytes" && f !== "cpuPct");
type ServiceRow = { unit: string } & { [K in (typeof SERVICE_FIELDS)[number]]: unknown };

/** An input row as it will be STORED: normalized figures, derived controllable. */
function storedServiceRow(r: AssetServiceInput): ServiceRow & AssetServiceInput & { controllable: boolean } {
  return { ...r, memBytes: normalizeBytes(r.memBytes), cpuPct: normalizeCpuPct(r.cpuPct), controllable: isServiceControllable(r) };
}

/**
 * Current-state service inventory for one asset, written as a DELTA
 * (utils/inventoryDelta): in one transaction, read the host's rows, create the
 * units that appeared, delete the ones that vanished, update only the ones
 * that changed, and stamp the scrape time (AssetInventoryScrape). A reader
 * still sees the old set or the new set, never a mix. An empty `rows` is a
 * valid delete-only scrape (a host that lost its agent / has no services).
 *
 * CPU and memory are stored rounded and compared through a dead band (a point
 * of CPU, 2% of memory) — a raw figure jitters every scrape and would mark
 * every running service changed. A stored figure can lag by up to one band.
 * Returns the delta's counts (the tests read them; nothing else needs them).
 */
export async function persistAssetServices(
  assetId: string,
  rows: AssetServiceInput[],
  now: Date = new Date(),
): Promise<{ created: number; updated: number; removed: number; unchanged: number }> {
  const incoming = rows.map(storedServiceRow);
  return retryOnDeadlock(() =>
    prisma.$transaction(
      async (tx) => {
        const existing = await tx.assetService.findMany({
          where: { assetId },
          select: { id: true, unit: true, ...Object.fromEntries(SERVICE_FIELDS.map((f) => [f, true])) },
        }) as unknown as Array<ServiceRow & { id: string }>;
        const delta = diffInventory(existing, incoming, (r) => r.unit, (e) => e.unit,
          (e, n) => sameInventoryRow<ServiceRow>(e, n, SERVICE_EXACT_FIELDS, "cpuPct", "memBytes"));
        if (delta.remove.length > 0) {
          await tx.assetService.deleteMany({ where: { id: { in: delta.remove.map((e) => e.id) } } });
        }
        if (delta.create.length > 0) {
          await tx.assetService.createMany({
            data: delta.create.map((r) => ({ id: randomUUID(), assetId, unit: r.unit, ...pickServiceFields(r) })),
            skipDuplicates: true,
          });
        }
        // updateMany, not update: a concurrent push for the same host may have
        // deleted the row between our read and this write, and update would
        // throw where this is a no-op the next scrape converges.
        for (const { existing: e, next } of delta.update) {
          await tx.assetService.updateMany({ where: { id: e.id }, data: pickServiceFields(next) });
        }
        await tx.assetInventoryScrape.upsert({
          where: { assetId_kind: { assetId, kind: "services" } },
          create: { assetId, kind: "services", scrapedAt: now },
          update: { scrapedAt: now },
        });
        return { created: delta.create.length, updated: delta.update.length, removed: delta.remove.length, unchanged: delta.unchanged };
      },
      // The first write after the upgrade updates every row once (the stored
      // figures are re-rounded); steady state is a handful.
      { timeout: 30_000 },
    ),
  );
}

function pickServiceFields(r: ReturnType<typeof storedServiceRow>) {
  return {
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
    controllable: r.controllable,
  };
}

/**
 * Whether an asset has anything for the Services and Software tabs to show —
 * the asset slide-over draws each tab only when this says so, so a host
 * nothing reports on (no agent, no agentless process polling, no Intune / Arc
 * software read) does not carry two permanently empty tabs.
 *
 * A scrape stamp counts as well as rows: a source that reported an EMPTY list
 * is still pulling that information in, and its tab should say so. Services
 * covers the process inventory too, which that tab folds in. Five indexed
 * existence reads; no rows are loaded.
 */
export async function getInventoryPresence(assetId: string): Promise<{ services: boolean; software: boolean }> {
  const [svc, proc, sw, svcScrape, swScrape] = await Promise.all([
    prisma.assetService.findFirst({ where: { assetId }, select: { id: true } }),
    prisma.assetProcess.findFirst({ where: { assetId }, select: { id: true } }),
    prisma.assetSoftware.findFirst({ where: { assetId }, select: { id: true } }),
    prisma.assetInventoryScrape.findFirst({ where: { assetId, kind: { in: ["services", "processes"] } }, select: { kind: true } }),
    prisma.assetInventoryScrape.findFirst({ where: { assetId, kind: { startsWith: "software" } }, select: { kind: true } }),
  ]);
  return { services: !!(svc || proc || svcScrape), software: !!(sw || swScrape) };
}
