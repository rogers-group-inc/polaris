/**
 * tests/unit/integrationAdapters.test.ts — one adapter per integration type
 * (services/integrationAdapters.ts, CQ-B064).
 *
 * The backend's per-type dispatch (connection test, discovery preflight,
 * device-vs-DHCP discovery, the product label) used to be the same if-chain
 * written in several places, and a type missed in one failed silently. These
 * pin that the registry covers every type the API accepts and the operator
 * screens name, and that each preflight says exactly what the hand-written
 * checks said.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const { INTEGRATION_TYPES, INTEGRATION_ADAPTERS, integrationAdapter } = await import("../../src/services/integrationAdapters.js");

const read = (p: string) => readFileSync(resolve(__dirname, "../..", p), "utf8");

describe("the registry covers every integration type", () => {
  it("matches CreateIntegrationSchema's type literals, both ways", () => {
    const src = read("src/api/routes/integrations.ts");
    const start = src.indexOf("const CreateIntegrationSchema = z.discriminatedUnion(");
    const block = src.slice(start, src.indexOf("\n]);", start));
    const literals = [...block.matchAll(/type:\s*z\.literal\(\s*(?:"([a-z]+)"|(GENERIC_API_TYPE))\s*\)/g)]
      .map((m) => m[1] ?? "genericapi");
    expect(literals.length).toBeGreaterThan(10);
    expect([...literals].sort()).toEqual([...INTEGRATION_TYPES].sort());
  });

  it("has an adapter for each type, and only those", () => {
    expect(Object.keys(INTEGRATION_ADAPTERS).sort()).toEqual([...INTEGRATION_TYPES].sort());
    expect(integrationAdapter("not-a-type")).toBeUndefined();
  });

  it("labels each type with the product name the integration modal shows", () => {
    const js = read("public/js/integrations.js");
    const block = js.slice(js.indexOf("var _INTEGRATION_PRODUCTS = {"), js.indexOf("};", js.indexOf("var _INTEGRATION_PRODUCTS = {")));
    const ui = Object.fromEntries([...block.matchAll(/(\w+):\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]));
    for (const t of INTEGRATION_TYPES) expect(INTEGRATION_ADAPTERS[t].label, t).toBe(ui[t]);
  });
});

describe("discovery facts", () => {
  it("splits gates / DHCP servers from inventory sources, and the assistant discovers nothing", () => {
    const kind = (t: string) => integrationAdapter(t)!.discovery?.kind ?? null;
    expect(["fortimanager", "fortigate", "windowsserver"].map(kind)).toEqual(["dhcp", "dhcp", "dhcp"]);
    expect(["entraid", "activedirectory", "vcenter", "azurearc", "unraid", "truenas", "proxmox", "genericapi"].map(kind))
      .toEqual(Array(8).fill("assets"));
    expect(kind("llm")).toBeNull();
  });

  // The hand-written triggerDiscovery checks, case for case.
  const missing = (t: string, config: Record<string, unknown>) => integrationAdapter(t)!.discovery!.missingConfig(config);

  it("hostless Microsoft types ask for the app registration, in order", () => {
    for (const t of ["entraid", "azurearc"]) {
      expect(missing(t, {})).toBe("Integration has no tenant ID configured");
      expect(missing(t, { tenantId: "t" })).toBe("Integration has no client ID configured");
      expect(missing(t, { tenantId: "t", clientId: "c" })).toBe("Integration has no client secret configured");
      expect(missing(t, { tenantId: "t", clientId: "c", clientSecret: "s" })).toBeNull();
    }
  });

  it("every other type asks for a host first, then its own credentials", () => {
    for (const t of ["fortimanager", "fortigate", "windowsserver", "activedirectory", "vcenter", "unraid", "truenas", "proxmox", "genericapi"]) {
      expect(missing(t, {}), t).toBe("Integration has no host configured");
    }
    expect(missing("fortimanager", { host: "h" })).toBe("Integration has no API token configured");
    expect(missing("fortigate", { host: "h" })).toBe("Integration has no API token configured");
    expect(missing("windowsserver", { host: "h" })).toBe("Integration has no username configured");
    expect(missing("activedirectory", { host: "h" })).toBe("Integration has no bind DN configured");
    expect(missing("activedirectory", { host: "h", bindDn: "d" })).toBe("Integration has no bind password configured");
    expect(missing("activedirectory", { host: "h", bindDn: "d", bindPassword: "p" })).toBe("Integration has no base DN configured");
    expect(missing("vcenter", { host: "h" })).toBe("Integration has no username configured");
    expect(missing("vcenter", { host: "h", username: "u" })).toBe("Integration has no password configured");
    expect(missing("unraid", { host: "h" })).toBe("Integration has no API key configured");
    expect(missing("truenas", { host: "h" })).toBe("Integration has no API key configured");
    expect(missing("proxmox", { host: "h" })).toBe("Integration has no API key configured");
    expect(missing("proxmox", { host: "h", apiToken: "k" })).toBe("Integration has no API token ID configured");
    expect(missing("proxmox", { host: "h", apiToken: "k", apiTokenId: "u@pam!t" })).toBeNull();
  });

  it("a Generic API feed needs an identity mapping, or a network query when it reads no devices", () => {
    expect(missing("genericapi", { host: "h" })).toBe("Integration has no path mapped for its identity field (id)");
    expect(missing("genericapi", { host: "h", identityField: "serial", fieldMap: { id: "$.id" } }))
      .toBe("Integration has no path mapped for its identity field (serial)");
    expect(missing("genericapi", { host: "h", fieldMap: { id: "$.id" } })).toBeNull();
    expect(missing("genericapi", { host: "h", readDevices: false }))
      .toBe("Integration reads no devices and has no network queries — there is nothing to discover");
    expect(missing("genericapi", { host: "h", readDevices: false, networkQueries: [{}] })).toBeNull();
  });
});

describe("connection tests", () => {
  it("only FortiManager is handed the stored integration's id", async () => {
    const fmg = await import("../../src/services/fortimanagerService.js");
    const fgt = await import("../../src/services/fortigateService.js");
    const a = vi.spyOn(fmg, "testConnection").mockResolvedValue({ ok: true, message: "fmg" });
    const b = vi.spyOn(fgt, "testConnection").mockResolvedValue({ ok: true, message: "fgt" });
    await INTEGRATION_ADAPTERS.fortimanager.testConnection({ host: "h" }, "int-1");
    await INTEGRATION_ADAPTERS.fortigate.testConnection({ host: "h" }, "int-2");
    expect(a).toHaveBeenCalledWith({ host: "h" }, "int-1");
    expect(b).toHaveBeenCalledWith({ host: "h" });
  });
});
