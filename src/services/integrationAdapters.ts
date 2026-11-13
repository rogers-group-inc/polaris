/**
 * src/services/integrationAdapters.ts
 *
 * One entry per integration type: what the backend's type DISPATCH needs to
 * know about it (CQ-B064). Before this, the same per-type if-chain was written
 * by hand in several places — the stored-integration test
 * (discoveryEngine.runPreflightTest), the unsaved-form test (POST
 * /integrations/test), triggerDiscovery's config checks, runDiscovery's
 * "device vs DHCP discovery" lists, and syncDhcpSubnets' label ternary — and a
 * type missed in one of them failed SILENTLY: an unknown-type test result, a
 * discovery run that fell into the FortiManager `else` branch, a run labelled
 * "DHCP discovery" that read no DHCP at all.
 *
 * `INTEGRATION_ADAPTERS` is typed `{ [K in IntegrationType]: … }`, so a type
 * added to INTEGRATION_TYPES without an entry here is a TYPE ERROR, and
 * POST /integrations/test indexes it with the Zod-parsed `input.type`, so a
 * literal added to CreateIntegrationSchema without one here is a type error
 * too. tests/unit/integrationAdapters.test.ts pins the two lists equal at
 * runtime.
 *
 * Scope: the backend dispatch that has one shape across types. Still per
 * type, by design: the discovery collectors themselves (runDiscovery's
 * per-type branches call different functions with different post-sync
 * passes), the /:id/query proxy (each type parses its own request body), and
 * the frontend modal (polaris-change-impact → integration-type-onboarding.md
 * is still the checklist there).
 */

import * as fortimanager from "./fortimanagerService.js";
import * as fortigate from "./fortigateService.js";
import * as windowsServer from "./windowsServerService.js";
import * as entraId from "./entraIdService.js";
import * as activeDirectory from "./activeDirectoryService.js";
import * as vcenter from "./vcenterService.js";
import * as azureArc from "./azureArcService.js";
import * as unraid from "./unraidService.js";
import * as truenas from "./truenasService.js";
import * as proxmox from "./proxmoxService.js";
import * as llm from "./llmService.js";
import * as genericApi from "./genericApiService.js";
import * as arcgis from "./arcgisService.js";
import { GENERIC_API_TYPE } from "../utils/genericApiSource.js";

/** Every integration type Polaris knows. Integration.type holds exactly one of these. */
export const INTEGRATION_TYPES = [
  "fortimanager", "fortigate", "windowsserver", "entraid", "activedirectory",
  "vcenter", "azurearc", "unraid", "truenas", "proxmox", "llm", GENERIC_API_TYPE, "arcgis",
] as const;
export type IntegrationType = (typeof INTEGRATION_TYPES)[number];

interface ConnectionTestResult { ok: boolean; message: string; version?: string }

export interface IntegrationAdapter {
  /** The product name an operator reads (matches public/js/integrations.js _INTEGRATION_PRODUCTS). */
  label: string;
  /**
   * Test a config. `integrationId` is present for a STORED integration and
   * absent for an unsaved form (only FortiManager uses it — its proxy-mode
   * concurrency gate is per integration).
   */
  testConnection(config: any, integrationId?: string): Promise<ConnectionTestResult>;
  /** null: nothing to discover (the AI assistant, rule 95; ArcGIS). */
  discovery: null | {
    /**
     * "dhcp": a gate / DHCP server — the run reads networks and leases and
     * goes through syncDhcpSubnets. "assets": an inventory source — the run
     * syncs assets only and gets the asset-only post-sync passes.
     */
    kind: "dhcp" | "assets";
    /** The operator message for the first config field a run cannot start without; null when ready. */
    missingConfig(config: Record<string, unknown>): string | null;
  };
}

// The checks every host-addressed type shares: a host, then its own fields.
function needs(fields: Array<[string, string]>): (config: Record<string, unknown>) => string | null {
  return (config) => {
    for (const [key, label] of fields) if (!config[key]) return `Integration has no ${label} configured`;
    return null;
  };
}
const HOST: [string, string] = ["host", "host"];

export const INTEGRATION_ADAPTERS: { readonly [K in IntegrationType]: IntegrationAdapter } = {
  fortimanager: {
    label: "FortiManager",
    testConnection: (config, integrationId) => fortimanager.testConnection(config, integrationId),
    discovery: { kind: "dhcp", missingConfig: needs([HOST, ["apiToken", "API token"]]) },
  },
  fortigate: {
    label: "FortiGate",
    testConnection: (config) => fortigate.testConnection(config),
    discovery: { kind: "dhcp", missingConfig: needs([HOST, ["apiToken", "API token"]]) },
  },
  windowsserver: {
    label: "Windows Server",
    testConnection: (config) => windowsServer.testConnection(config),
    discovery: { kind: "dhcp", missingConfig: needs([HOST, ["username", "username"]]) },
  },
  // Hostless: an app registration against a fixed Microsoft endpoint.
  entraid: {
    label: "Entra ID",
    testConnection: (config) => entraId.testConnection(config),
    discovery: { kind: "assets", missingConfig: needs([["tenantId", "tenant ID"], ["clientId", "client ID"], ["clientSecret", "client secret"]]) },
  },
  activedirectory: {
    label: "Active Directory",
    testConnection: (config) => activeDirectory.testConnection(config),
    discovery: { kind: "assets", missingConfig: needs([HOST, ["bindDn", "bind DN"], ["bindPassword", "bind password"], ["baseDn", "base DN"]]) },
  },
  vcenter: {
    label: "vCenter",
    testConnection: (config) => vcenter.testConnection(config),
    discovery: { kind: "assets", missingConfig: needs([HOST, ["username", "username"], ["password", "password"]]) },
  },
  azurearc: {
    label: "Azure Arc",
    testConnection: (config) => azureArc.testConnection(config),
    discovery: { kind: "assets", missingConfig: needs([["tenantId", "tenant ID"], ["clientId", "client ID"], ["clientSecret", "client secret"]]) },
  },
  unraid: {
    label: "Unraid",
    testConnection: (config) => unraid.testConnection(config),
    discovery: { kind: "assets", missingConfig: needs([HOST, ["apiToken", "API key"]]) },
  },
  truenas: {
    label: "TrueNAS SCALE",
    testConnection: (config) => truenas.testConnection(config),
    discovery: { kind: "assets", missingConfig: needs([HOST, ["apiToken", "API key"]]) },
  },
  proxmox: {
    label: "Proxmox VE",
    testConnection: (config) => proxmox.testConnection(config),
    discovery: { kind: "assets", missingConfig: needs([HOST, ["apiToken", "API key"], ["apiTokenId", "API token ID"]]) },
  },
  llm: {
    label: "AI Assistant",
    testConnection: (config) => llm.testConnection(config),
    discovery: null,
  },
  [GENERIC_API_TYPE]: {
    label: "Generic API",
    testConnection: (config) => genericApi.testConnection(config),
    discovery: {
      kind: "assets",
      missingConfig: (config) => {
        if (!config.host) return "Integration has no host configured";
        // The mapping is what makes a record an asset, so a run with nothing
        // mapped for the identity would read the feed and write nothing. A
        // network-only feed (readDevices off, rule 100(j)) needs a network
        // query instead — otherwise the run reads nothing at all.
        if (config.readDevices === false) {
          const nq = Array.isArray(config.networkQueries) ? config.networkQueries.length : 0;
          return nq === 0 ? "Integration reads no devices and has no network queries — there is nothing to discover" : null;
        }
        const fm = (config.fieldMap ?? {}) as Record<string, unknown>;
        const idField = (config.identityField as string | undefined) ?? "id";
        return fm[idField] ? null : `Integration has no path mapped for its identity field (${idField})`;
      },
    },
  },
  // A map / GIS service: satellite imagery and cable-run write-back, no inventory.
  arcgis: {
    label: "ArcGIS",
    testConnection: (config) => arcgis.testConnection(config),
    discovery: null,
  },
};

/** The adapter for a stored type string, or undefined for one Polaris does not know. */
export function integrationAdapter(type: string): IntegrationAdapter | undefined {
  return (INTEGRATION_ADAPTERS as Record<string, IntegrationAdapter | undefined>)[type];
}

/**
 * The types with nothing to discover (`discovery: null`). The scheduler skips
 * them and create / update force their `autoDiscover` off.
 */
export const NON_DISCOVERY_TYPES: readonly IntegrationType[] =
  INTEGRATION_TYPES.filter((t) => INTEGRATION_ADAPTERS[t].discovery === null);

/** True for a type with nothing to discover. */
export function isNonDiscoveryType(type: string): boolean {
  return (NON_DISCOVERY_TYPES as readonly string[]).includes(type);
}
