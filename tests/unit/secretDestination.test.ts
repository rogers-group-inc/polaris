/**
 * tests/unit/secretDestination.test.ts
 *
 * Business rule 111: a stored secret follows its destination. A blank or masked
 * secret is restored from the stored row only while the host / port / token URL /
 * transport are unchanged; once any of them moves, the caller must type the secret.
 */

import { describe, it, expect } from "vitest";
import { movedDestinationKey, restoreStoredSecrets, isBlankSecret } from "../../src/utils/secretDestination.js";
import { SECRET_MASK } from "../../src/utils/secretMask.js";

const stored = { host: "10.0.0.5", port: 443, apiToken: "real-token", verifySsl: false, useHttps: true };

describe("isBlankSecret", () => {
  it.each([undefined, null, "", "   ", SECRET_MASK, 0, {}])("treats %j as 'keep the stored one'", (v) => {
    expect(isBlankSecret(v)).toBe(true);
  });
  it("treats a typed value as a new secret", () => {
    expect(isBlankSecret("new-token")).toBe(false);
  });
});

describe("movedDestinationKey", () => {
  it("is null when nothing moved, whatever the spelling noise", () => {
    expect(movedDestinationKey(stored, { host: "10.0.0.5", port: 443 })).toBeNull();
    expect(movedDestinationKey(stored, { host: " 10.0.0.5. ", port: "443" })).toBeNull();
    expect(movedDestinationKey({ host: "FW1.Corp.Example" }, { host: "fw1.corp.example" })).toBeNull();
    expect(movedDestinationKey({ tokenUrl: "https://idp.example/token/" }, { tokenUrl: "https://idp.example/token" })).toBeNull();
  });

  it("treats an omitted key as unchanged", () => {
    expect(movedDestinationKey(stored, {})).toBeNull();
    expect(movedDestinationKey(stored, { apiToken: "" })).toBeNull();
  });

  it("ignores a key the stored row never had", () => {
    expect(movedDestinationKey({ host: "10.0.0.5" }, { host: "10.0.0.5", port: 8443 })).toBeNull();
  });

  it.each([
    ["host", { host: "evil.example" }],
    ["port", { port: 8443 }],
    ["useHttps", { useHttps: false }],
    ["verifySsl", { verifySsl: true }],
  ])("reports a moved %s", (key, incoming) => {
    expect(movedDestinationKey(stored, incoming as Record<string, unknown>)).toBe(key);
  });

  it("reports a workload integration dropping TLS", () => {
    expect(movedDestinationKey({ host: "nas", useTls: true }, { host: "nas", useTls: false })).toBe("useTls");
  });

  it("reports an added Proxmox fallback node, even on a row stored before the list existed", () => {
    expect(movedDestinationKey({ fallbackHosts: ["pve2"] }, { fallbackHosts: ["pve2", "evil.example"] })).toBe("fallbackHosts");
    expect(movedDestinationKey({ host: "pve1" }, { host: "pve1", fallbackHosts: ["evil.example"] })).toBe("fallbackHosts");
    expect(movedDestinationKey({ host: "pve1" }, { host: "pve1", fallbackHosts: [] })).toBeNull();
  });

  it("does not treat reordered fallback nodes as a move", () => {
    expect(movedDestinationKey({ fallbackHosts: ["pve2", "PVE3."] }, { fallbackHosts: ["pve3", "pve2"] })).toBeNull();
  });

  it("reports a moved token URL, base URL and SMTP security", () => {
    expect(movedDestinationKey({ tokenUrl: "https://a/t" }, { tokenUrl: "https://b/t" })).toBe("tokenUrl");
    expect(movedDestinationKey({ baseUrl: "https://a" }, { baseUrl: "https://b" })).toBe("baseUrl");
    expect(movedDestinationKey({ security: "starttls" }, { security: "none" })).toBe("security");
  });
});

describe("restoreStoredSecrets", () => {
  it("restores a blank secret while the destination is unchanged", () => {
    const cfg: Record<string, unknown> = { host: "10.0.0.5", apiToken: "" };
    restoreStoredSecrets(cfg, stored, ["apiToken"]);
    expect(cfg.apiToken).toBe("real-token");
  });

  it("restores a masked secret and an omitted one", () => {
    const masked: Record<string, unknown> = { host: "10.0.0.5", apiToken: SECRET_MASK };
    restoreStoredSecrets(masked, stored, ["apiToken"]);
    expect(masked.apiToken).toBe("real-token");
    const omitted: Record<string, unknown> = { host: "10.0.0.5" };
    restoreStoredSecrets(omitted, stored, ["apiToken"]);
    expect(omitted.apiToken).toBe("real-token");
  });

  it("refuses to reuse the stored secret when the host moved", () => {
    const cfg: Record<string, unknown> = { host: "evil.example", apiToken: SECRET_MASK };
    expect(() => restoreStoredSecrets(cfg, stored, ["apiToken"])).toThrowError(/host.*never sent to a new destination/is);
    expect(cfg.apiToken).toBe(SECRET_MASK);
  });

  it("refuses on a moved port or transport as well", () => {
    expect(() => restoreStoredSecrets({ port: 25 }, stored, ["apiToken"])).toThrowError(/"port" was changed/);
    expect(() => restoreStoredSecrets({ useHttps: false }, stored, ["apiToken"])).toThrowError(/"useHttps" was changed/);
  });

  it("accepts a moved destination when the secret is typed again", () => {
    const cfg: Record<string, unknown> = { host: "new.example", apiToken: "typed-again" };
    restoreStoredSecrets(cfg, stored, ["apiToken"]);
    expect(cfg.apiToken).toBe("typed-again");
  });

  it("does nothing when no secret is stored, even if the destination moved", () => {
    const cfg: Record<string, unknown> = { host: "new.example", apiToken: "" };
    restoreStoredSecrets(cfg, { host: "10.0.0.5" }, ["apiToken"]);
    expect(cfg.apiToken).toBe("");
  });

  it("only complains about the secrets that would have been reused", () => {
    const cfg: Record<string, unknown> = { host: "new.example", apiToken: "typed", password: "" };
    expect(() => restoreStoredSecrets(cfg, { host: "10.0.0.5", apiToken: "a", password: "p" }, ["apiToken", "password"])).toThrowError(/stored password/);
  });

  it("compares against the request body, not a merged config", () => {
    const merged: Record<string, unknown> = { ...stored, apiToken: undefined };
    // The request said nothing about the host, so the merged-in stored host is not a move.
    restoreStoredSecrets(merged, stored, ["apiToken"], { name: "renamed" });
    expect(merged.apiToken).toBe("real-token");
  });
});
