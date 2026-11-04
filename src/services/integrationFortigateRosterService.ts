/**
 * src/services/integrationFortigateRosterService.ts
 *
 * The FortiGates a FortiManager / FortiGate integration has discovered, by the
 * name its queries take: FortiManager's device name
 * (`fortinetTopology.deviceName`), which routinely differs from the gate's own
 * hostname. Feeds the FortiGate picker of the integration's Query API window,
 * where that name fills `<device-name>` in a FortiManager JSON-RPC query and
 * the Target FortiGate of a direct-to-FortiGate one.
 *
 * Read-only, one query: discovered firewalls of this integration that are not
 * decommissioned. An HA pair is one entry (both members carry the cluster's
 * one FortiManager name); the primary's hostname and address describe it.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";

export interface IntegrationFortigate {
  /** The name FortiManager queries take (`/adom/<adom>/device/<name>`). */
  deviceName: string;
  /** The gate's own hostname, when it differs from `deviceName`. */
  hostname: string | null;
  ipAddress: string | null;
  serialNumber: string | null;
  status: string;
}

interface FirewallRow {
  hostname: string | null;
  ipAddress: string | null;
  serialNumber: string | null;
  status: string;
  fortinetTopology: unknown;
}

/** Shape and de-duplicate firewall rows into the picker list (pure; exported for tests). */
export function fortigateRosterFromAssets(rows: readonly FirewallRow[]): IntegrationFortigate[] {
  const byName = new Map<string, { entry: IntegrationFortigate; primary: boolean }>();
  for (const r of rows) {
    const topo = (r.fortinetTopology && typeof r.fortinetTopology === "object")
      ? r.fortinetTopology as Record<string, unknown>
      : {};
    const deviceName = (typeof topo.deviceName === "string" && topo.deviceName.trim()) || (r.hostname || "").trim();
    if (!deviceName) continue;
    const primary = topo.haRole !== "secondary";
    const entry: IntegrationFortigate = {
      deviceName,
      hostname: r.hostname && r.hostname !== deviceName ? r.hostname : null,
      ipAddress: r.ipAddress,
      serialNumber: r.serialNumber,
      status: r.status,
    };
    const key = deviceName.toLowerCase();
    const prior = byName.get(key);
    // An HA pair: the primary describes the cluster; a standby fills in only
    // when no primary row exists.
    if (!prior || (primary && !prior.primary)) byName.set(key, { entry, primary });
  }
  return [...byName.values()]
    .map((v) => v.entry)
    .sort((a, b) => a.deviceName.localeCompare(b.deviceName, undefined, { sensitivity: "base", numeric: true }));
}

/**
 * The discovered, not-decommissioned FortiGates of one integration.
 * 404 for an unknown integration; 400 for a type that discovers no FortiGates.
 */
export async function listIntegrationFortigates(integrationId: string): Promise<IntegrationFortigate[]> {
  const integration = await prisma.integration.findUnique({ where: { id: integrationId }, select: { type: true } });
  if (!integration) throw new AppError(404, "Integration not found");
  if (integration.type !== "fortimanager" && integration.type !== "fortigate") {
    throw new AppError(400, "Only FortiManager and FortiGate integrations discover FortiGates");
  }
  const rows = await prisma.asset.findMany({
    where: {
      discoveredByIntegrationId: integrationId,
      assetType: "firewall",
      status: { not: "decommissioned" },
    },
    select: { hostname: true, ipAddress: true, serialNumber: true, status: true, fortinetTopology: true },
  });
  return fortigateRosterFromAssets(rows);
}
