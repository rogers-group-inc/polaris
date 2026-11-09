import { describe, it, expect } from "vitest";
import { pickRestApiCredential, restApiCredentialAuth, type FortinetRestAuth } from "../../src/utils/fortinetRestCredential.js";

describe("pickRestApiCredential", () => {
  it("takes the first restapi-typed credential in the chain", () => {
    const stream = { type: "restapi", config: { apiToken: "a" } };
    const dflt   = { type: "restapi", config: { apiToken: "b" } };
    expect(pickRestApiCredential(stream, dflt)).toBe(stream);
  });

  it("falls through to the asset default when the stream has none", () => {
    const dflt = { type: "restapi", config: { apiToken: "b" } };
    expect(pickRestApiCredential(null, dflt)).toBe(dflt);
    expect(pickRestApiCredential(undefined, dflt)).toBe(dflt);
  });

  // The asset default is usually an SNMP community. Authenticating a REST call
  // with it would fail in a way that reads as a broken token.
  it("ignores credentials of every other type", () => {
    expect(pickRestApiCredential({ type: "snmp", config: { community: "x" } })).toBeNull();
    expect(pickRestApiCredential({ type: "ssh", config: {} }, { type: "winrm", config: {} })).toBeNull();
    expect(pickRestApiCredential({ type: "http", config: { authMode: "bearer" } })).toBeNull();
  });

  it("returns null on an empty chain", () => {
    expect(pickRestApiCredential()).toBeNull();
    expect(pickRestApiCredential(null, undefined, null)).toBeNull();
  });
});

describe("restApiCredentialAuth", () => {
  it("maps the token and defaults TLS verification off", () => {
    expect(restApiCredentialAuth({ baseUrl: "https://10.1.1.1", apiToken: "tok" })).toEqual({
      apiUser: "",
      apiToken: "tok",
      verifySsl: false,
    });
  });

  it("honours verifyTls only when it is literally true", () => {
    const on  = restApiCredentialAuth({ apiToken: "t", verifyTls: true });
    const off = restApiCredentialAuth({ apiToken: "t", verifyTls: "yes" });
    expect(on).toMatchObject({ verifySsl: true });
    expect(off).toMatchObject({ verifySsl: false });
  });

  // The port is the one piece of the baseUrl that survives — a gate on a
  // non-default management port is a real setup, a gate at a different ADDRESS
  // than the asset is a mis-attribution.
  it("carries a non-default port over from the baseUrl", () => {
    expect(restApiCredentialAuth({ baseUrl: "https://10.1.1.1:8443", apiToken: "t" }))
      .toMatchObject({ port: 8443 });
  });

  it("leaves the port unset for a default-port or absent baseUrl", () => {
    expect((restApiCredentialAuth({ baseUrl: "https://10.1.1.1", apiToken: "t" }) as FortinetRestAuth).port).toBeUndefined();
    expect((restApiCredentialAuth({ baseUrl: "https://10.1.1.1:443", apiToken: "t" }) as FortinetRestAuth).port).toBeUndefined();
    expect((restApiCredentialAuth({ apiToken: "t" }) as FortinetRestAuth).port).toBeUndefined();
  });

  it("ignores an unparseable baseUrl rather than failing the whole credential", () => {
    const auth = restApiCredentialAuth({ baseUrl: "not a url", apiToken: "t" });
    expect(auth).toEqual({ apiUser: "", apiToken: "t", verifySsl: false });
  });

  it("forwards apiUser when one is stored", () => {
    expect(restApiCredentialAuth({ apiToken: "t", apiUser: "polaris-ro" }))
      .toMatchObject({ apiUser: "polaris-ro" });
  });

  it("errors on a missing or blank token", () => {
    expect(restApiCredentialAuth({ baseUrl: "https://x" })).toEqual({
      error: "REST API credential is missing its API token",
    });
    expect(restApiCredentialAuth({ apiToken: "   " })).toHaveProperty("error");
    expect(restApiCredentialAuth(null)).toHaveProperty("error");
    expect(restApiCredentialAuth(undefined)).toHaveProperty("error");
  });
});
