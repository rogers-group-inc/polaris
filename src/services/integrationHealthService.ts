/**
 * src/services/integrationHealthService.ts
 *
 * Backs `GET /api/v1/integrations/health-summary`, the sidebar's 30-second
 * poll. Two unrelated signals ride one response on purpose: the sidebar already
 * fetches this on every page for every signed-in session, and neither signal is
 * worth a second poll of its own.
 *
 *   failed       — enabled integrations whose most recent connection test failed.
 *   proxyAdvice  — enabled FortiManager integrations still on the proxy
 *                  transport that manage more gates than proxy mode scales to.
 *
 * The proxy advisory is about THROUGHPUT, not capability. FMG forwards
 * per-device live queries through `/sys/proxy/json`, which FortiManager
 * serializes at concurrency 1 (see fmgWorker.ts) — so a poll cycle grows
 * linearly with the managed-gate count while direct mode parallelises up to 20.
 * Proxy mode's separate inability to collect a FortiGate's REST monitoring
 * streams is a real but SEPARATE (and fixable) problem; deliberately not
 * mentioned here, or this advisory would read as wrong the moment that lands.
 */

import { prisma } from "../db.js";

/**
 * Above this many managed FortiGates, proxy mode is the wrong transport.
 *
 * ONE number for one decision: the Direct Polling hint in
 * `public/js/integrations.js` states the same threshold in operator-facing
 * copy. Change both together — a modal and a sidebar advising different things
 * about the same fleet is worse than either number being slightly off.
 */
export const FMG_PROXY_GATE_ADVISORY_THRESHOLD = 10;

interface FailedIntegration {
  id: string;
  name: string;
  type: string;
  lastTestAt: Date | null;
}

export interface ProxyAdviceEntry {
  id: string;
  name: string;
  managedFortigates: number;
}

export interface IntegrationHealthSummary {
  failed: FailedIntegration[];
  proxyAdvice: ProxyAdviceEntry[];
  proxyAdviceThreshold: number;
}

/** Proxy is the DEFAULT, so an absent flag means proxy — the same `!== false`
 *  reading every other consumer of this field uses. */
export function integrationIsFmgProxyMode(config: unknown): boolean {
  return ((config as Record<string, unknown> | null) || {}).useProxy !== false;
}

/**
 * Pure half, so the threshold rule is testable without a database: pair each
 * proxy-mode integration with its gate count and keep only those over the line.
 */
export function selectProxyAdvice(
  integrations: Array<{ id: string; name: string }>,
  gateCountById: Map<string, number>,
  threshold: number = FMG_PROXY_GATE_ADVISORY_THRESHOLD,
): ProxyAdviceEntry[] {
  return integrations
    .map((i) => ({ id: i.id, name: i.name, managedFortigates: gateCountById.get(i.id) ?? 0 }))
    .filter((i) => i.managedFortigates > threshold);
}

export async function getIntegrationHealthSummary(): Promise<IntegrationHealthSummary> {
  const [failed, fmgIntegrations] = await Promise.all([
    prisma.integration.findMany({
      where: { enabled: true, lastTestOk: false },
      select: { id: true, name: true, type: true, lastTestAt: true },
      orderBy: { name: "asc" },
    }),
    prisma.integration.findMany({
      where: { enabled: true, type: "fortimanager" },
      select: { id: true, name: true, config: true },
      orderBy: { name: "asc" },
    }),
  ]);

  const proxyIntegrations = fmgIntegrations
    .filter((i) => integrationIsFmgProxyMode(i.config))
    .map((i) => ({ id: i.id, name: i.name }));

  let proxyAdvice: ProxyAdviceEntry[] = [];
  if (proxyIntegrations.length > 0) {
    // ONE groupBy, never a count per integration: this runs every 30s for every
    // signed-in session, and the fleet-size rule applies at 2000 assets.
    const counts = await prisma.asset.groupBy({
      by: ["discoveredByIntegrationId"],
      where: {
        assetType: "firewall",
        discoveredByIntegrationId: { in: proxyIntegrations.map((i) => i.id) },
      },
      _count: { _all: true },
    });
    const gateCountById = new Map<string, number>(
      counts
        .filter((c) => c.discoveredByIntegrationId !== null)
        .map((c) => [c.discoveredByIntegrationId as string, c._count._all]),
    );
    proxyAdvice = selectProxyAdvice(proxyIntegrations, gateCountById);
  }

  return { failed, proxyAdvice, proxyAdviceThreshold: FMG_PROXY_GATE_ADVISORY_THRESHOLD };
}
