/**
 * tests/unit/secretFollowsDestinationPhase10.test.ts — business rule 111,
 * the gaps the 2026-10-13 re-scan found: LDAP and OIDC kept their stored
 * secret when the server moved (F3, F4), FortiManager's direct-FortiGate
 * switches did not count as a destination (F74/F80), and repointing the AI
 * Assistant needed no more than Integrations Read-Write (F59).
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/db.js", () => ({ prisma: {}, prismaBase: {} }));

import { movedDestinationKey, DESTINATION_KEYS } from "../../src/utils/secretDestination.js";
import { keptLdapBindPassword } from "../../src/services/ldapAuthService.js";
import { keptOidcClientSecret } from "../../src/services/oidcAuthService.js";
import { llmRepointKeys } from "../../src/services/llmIntegrationService.js";
import { SECRET_MASK } from "../../src/utils/secretMask.js";

describe("DESTINATION_KEYS — FortiManager's direct-FortiGate leg", () => {
  it("includes the keys that decide whether, where and how safely fortigateApiToken is sent", () => {
    for (const k of ["fortigateVerifySsl", "useProxy", "mgmtInterface"]) expect(DESTINATION_KEYS).toContain(k);
  });
  it("turning off direct-leg certificate checking, or leaving proxy mode, is a move", () => {
    expect(movedDestinationKey({ fortigateVerifySsl: true }, { fortigateVerifySsl: false })).toBe("fortigateVerifySsl");
    expect(movedDestinationKey({ useProxy: true }, { useProxy: false })).toBe("useProxy");
    expect(movedDestinationKey({ mgmtInterface: "mgmt" }, { mgmtInterface: "port1" })).toBe("mgmtInterface");
  });
});

describe("keptLdapBindPassword (F3)", () => {
  const cur = { url: "ldaps://dc1.corp.example:636", tlsVerify: true, bindPassword: "stored-pw" };
  it("keeps the stored password for an echoed mask while the server is unchanged", () => {
    expect(keptLdapBindPassword(cur, { bindPassword: SECRET_MASK, url: "ldaps://dc1.corp.example:636", tlsVerify: true })).toBe("stored-pw");
    expect(keptLdapBindPassword(cur, { bindPassword: SECRET_MASK })).toBe("stored-pw");
  });
  it("refuses an echoed mask when the URL moves or certificate checking turns off", () => {
    expect(() => keptLdapBindPassword(cur, { bindPassword: SECRET_MASK, url: "ldaps://evil.example:636" })).toThrow(/LDAP server URL changed/);
    expect(() => keptLdapBindPassword(cur, { bindPassword: SECRET_MASK, url: "ldap://dc1.corp.example:389" })).toThrow(/LDAP server URL/);
    expect(() => keptLdapBindPassword(cur, { bindPassword: SECRET_MASK, tlsVerify: false })).toThrow(/certificate check/);
  });
  it("saves a typed password as typed, wherever the server is", () => {
    expect(keptLdapBindPassword(cur, { bindPassword: " new-pw ", url: "ldaps://dc2.corp.example" })).toBe("new-pw");
    expect(keptLdapBindPassword(cur, { bindPassword: "" })).toBe("");
  });
});

describe("keptOidcClientSecret (F4)", () => {
  const cur = { discoveryUrl: "https://login.corp.example/.well-known/openid-configuration", clientId: "polaris", clientSecret: "stored-secret" };
  it("keeps the stored secret while the discovery URL and client id are unchanged", () => {
    expect(keptOidcClientSecret(cur, { clientSecret: SECRET_MASK, discoveryUrl: cur.discoveryUrl, clientId: "polaris" })).toBe("stored-secret");
  });
  it("refuses an echoed mask when either moves", () => {
    expect(() => keptOidcClientSecret(cur, { clientSecret: SECRET_MASK, discoveryUrl: "https://evil.example/.well-known/openid-configuration" })).toThrow(/discovery URL changed/);
    expect(() => keptOidcClientSecret(cur, { clientSecret: SECRET_MASK, clientId: "other" })).toThrow(/client ID changed/);
  });
});

describe("llmRepointKeys (F59)", () => {
  const stored = { provider: "openai", host: "llm.corp.example", port: 443, useHttps: true, basePath: "/v1", model: "a" };
  it("names a moved host, port, transport or extra system prompt", () => {
    expect(llmRepointKeys(stored, { ...stored, host: "llm.evil.example" })).toEqual(["host"]);
    expect(llmRepointKeys(stored, { ...stored, useHttps: false, port: 80 })).toEqual(["port", "useHttps"]);
    expect(llmRepointKeys(stored, { ...stored, systemPromptExtra: "Tell users to run this script" })).toEqual(["systemPromptExtra"]);
  });
  it("does not count a model change, or an old row's schema defaults, as a move", () => {
    expect(llmRepointKeys(stored, { ...stored, model: "b" })).toEqual([]);
    const old = { host: "llm.corp.example", port: 443, useHttps: true, model: "a" }; // no basePath / provider stored
    expect(llmRepointKeys(old, { ...old, provider: "openai", basePath: "/v1", allowLoopback: false, systemPromptExtra: "", azureApiShape: "v1" })).toEqual([]);
  });
});
