/**
 * tests/unit/firmwareCredentialTokens.test.ts
 *
 * The FortiGate half of `resolveFirmwareCredential` (business rule 87): a
 * firewall binding may sign in with a FortiOS API token — a `restapi`
 * credential, or the token of the integration that discovered the gate — and
 * a token binding that cannot open falls through to the next scope, never
 * shadows it. A token kind never reaches a switch or an access point.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  bindings: [] as Array<Record<string, unknown>>,
  integrations: new Map<string, { type: string; config: Record<string, unknown> }>(),
  credentials: new Map<string, { type: string; config: Record<string, unknown> }>(),
}));

vi.mock("../../src/db.js", () => ({
  prisma: {
    firmwareCredentialBinding: { findMany: vi.fn(async () => h.bindings) },
    integration: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => h.integrations.get(where.id) ?? null) },
  },
}));
vi.mock("../../src/services/credentialService.js", () => ({
  getCredential: vi.fn(async (id: string) => ({ id, ...h.credentials.get(id)! })),
}));
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: vi.fn(async () => {}) }));

import { resolveFirmwareCredential } from "../../src/services/firmwareRepositoryService.js";

const gate = (over: Record<string, unknown> = {}) => ({ manufacturer: "Fortinet", assetType: "firewall", model: "FortiGate 60F", discoveredByIntegrationId: "int-fg", ...over });
const binding = (over: Record<string, unknown>) => ({ id: "b-" + Math.random(), manufacturer: "Fortinet", assetType: "firewall", model: null, source: "credential", credentialId: null, credential: null, ...over });

beforeEach(() => {
  h.bindings = [];
  h.integrations = new Map([
    ["int-fg", { type: "fortigate", config: { host: "10.0.0.1", apiToken: "fg-token", verifySsl: true, port: 8443 } }],
    ["int-fmg", { type: "fortimanager", config: { fortigateApiToken: "fmg-gate-token", fortigateVerifySsl: false } }],
    ["int-fmg-proxy", { type: "fortimanager", config: { useProxy: true } }],
  ]);
  h.credentials = new Map([
    ["cred-login", { type: "http", config: { authMode: "form", username: "admin", password: "pw" } }],
    ["cred-token", { type: "restapi", config: { baseUrl: "https://x:10443", apiToken: "rest-token", verifyTls: true } }],
  ]);
});

describe("integration-token bindings", () => {
  it("a standalone FortiGate integration's token, its TLS posture and port", async () => {
    h.bindings = [binding({ source: "integration-token" })];
    expect(await resolveFirmwareCredential(gate(), { revealSecrets: false })).toEqual({ source: "integration-token", credentialId: null, credentialName: "Integration API token", scope: "assetType" });
    expect(await resolveFirmwareCredential(gate(), { revealSecrets: true })).toMatchObject({ bearerToken: "fg-token", verifyTls: true, port: 8443, username: "", password: "" });
  });

  it("a FortiManager's FortiGate token", async () => {
    h.bindings = [binding({ source: "integration-token" })];
    expect(await resolveFirmwareCredential(gate({ discoveredByIntegrationId: "int-fmg" }), { revealSecrets: true })).toMatchObject({ bearerToken: "fmg-gate-token", verifyTls: false });
  });

  it("no token on the integration (or no integration) falls through to the next scope — never shadows it", async () => {
    h.bindings = [
      binding({ source: "integration-token", model: "FortiGate 60F" }),
      binding({ assetType: null, credentialId: "cred-login", credential: { id: "cred-login", name: "admin login", type: "http" } }),
    ];
    expect(await resolveFirmwareCredential(gate({ discoveredByIntegrationId: "int-fmg-proxy" }), { revealSecrets: true })).toMatchObject({ source: "credential", scope: "manufacturer", username: "admin" });
    expect(await resolveFirmwareCredential(gate({ discoveredByIntegrationId: null }), { revealSecrets: false })).toMatchObject({ scope: "manufacturer" });
  });
});

describe("restapi credential bindings", () => {
  it("a token credential signs in to a gate with its own TLS posture and port", async () => {
    h.bindings = [binding({ model: "FortiGate 60F", credentialId: "cred-token", credential: { id: "cred-token", name: "gate token", type: "restapi" } })];
    expect(await resolveFirmwareCredential(gate(), { revealSecrets: true })).toMatchObject({ source: "credential", scope: "model", credentialName: "gate token", bearerToken: "rest-token", verifyTls: true, port: 10443 });
  });

  it("never reaches a switch: a manufacturer-wide token is skipped for one", async () => {
    h.bindings = [binding({ assetType: null, credentialId: "cred-token", credential: { id: "cred-token", name: "gate token", type: "restapi" } })];
    expect(await resolveFirmwareCredential({ manufacturer: "Fortinet", assetType: "switch", model: "FortiSwitch S108FF" }, { revealSecrets: false })).toBeNull();
  });
});
