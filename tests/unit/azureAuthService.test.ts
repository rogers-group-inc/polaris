/**
 * tests/unit/azureAuthService.test.ts — Azure SAML SSO: the `sso` setting
 * (defaults merge, trim, clamp), the "configured" gate, the SAML client it
 * builds (and rebuilds after a settings change), the login / logout URLs, and
 * the claim extraction that hands a SAML profile to provisionExternalUser.
 *
 * The assertion-replay half of validateSamlResponse is pinned by
 * tests/unit/samlReplay.test.ts; only the no-profile refusal is repeated here.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  raw: undefined as unknown,
  saved: [] as unknown[],
  ctor: vi.fn(),
  authorize: vi.fn(),
  validatePost: vi.fn(),
  logout: vi.fn(),
  provision: vi.fn(),
}));

vi.mock("@node-saml/node-saml", () => ({
  ValidateInResponseTo: { never: "never", ifPresent: "ifPresent", always: "always" },
  SAML: class {
    constructor(cfg: unknown) {
      h.ctor(cfg);
    }
    getAuthorizeUrlAsync = h.authorize;
    validatePostResponseAsync = h.validatePost;
    getLogoutUrlAsync = h.logout;
  },
}));
vi.mock("../../src/services/settingsStore.js", () => ({
  createSettingStore: (opts: { parse: (raw: unknown) => unknown }) => ({
    get: async () => opts.parse(h.raw),
    peek: () => null,
    save: async (v: unknown) => {
      h.saved.push(v);
      h.raw = v;
      return v;
    },
    invalidate: () => {},
  }),
}));
vi.mock("../../src/services/ssoProvisioning.js", () => ({ provisionExternalUser: h.provision }));
vi.mock("../../src/db.js", () => import("./_dbStub.js"));

import {
  getSsoSettings,
  updateSsoSettings,
  isAzureSsoConfiguredAsync,
  getSamlLoginUrl,
  validateSamlResponse,
  getSamlLogoutUrl,
  findOrProvisionSamlUser,
} from "../../src/services/azureAuthService.js";
import { clearSamlReplayCache } from "../../src/utils/samlReplayCache.js";

const CONFIGURED = {
  enabled: true,
  spEntityId: "https://polaris.example.com",
  idpEntityId: "https://idp.example.com/entity",
  idpLoginUrl: "https://idp.example.com/login",
  idpLogoutUrl: "",
  idpCertificate: "CERT",
  wantResponseSigned: false,
  skipLoginPage: false,
  autoLogoutMinutes: 0,
};

/** Set the stored row and drop the cached SAML client (updateSsoSettings does both). */
async function store(raw: unknown): Promise<void> {
  h.raw = raw;
  await updateSsoSettings({});
  h.saved.length = 0;
}

function lastConfig(): Record<string, unknown> {
  const calls = h.ctor.mock.calls;
  return calls[calls.length - 1][0] as Record<string, unknown>;
}

beforeEach(async () => {
  h.ctor.mockReset();
  h.authorize.mockReset();
  h.validatePost.mockReset();
  h.logout.mockReset();
  h.provision.mockReset();
  h.provision.mockImplementation(async (p: unknown) => p);
  h.authorize.mockResolvedValue("https://idp.example.com/login?SAMLRequest=x");
  h.logout.mockResolvedValue("https://idp.example.com/logout?SAMLRequest=y");
  clearSamlReplayCache();
  await store({ ...CONFIGURED });
});

describe("getSsoSettings", () => {
  it("answers the defaults when no row is stored", async () => {
    h.raw = undefined;
    expect(await getSsoSettings()).toEqual({
      enabled: false, spEntityId: "", idpEntityId: "", idpLoginUrl: "", idpLogoutUrl: "",
      idpCertificate: "", wantResponseSigned: false, skipLoginPage: false, autoLogoutMinutes: 0,
    });
  });

  it("fills a partial stored row from the defaults", async () => {
    h.raw = { enabled: true, idpLoginUrl: "https://idp/login" };
    const s = await getSsoSettings();
    expect(s.enabled).toBe(true);
    expect(s.idpLoginUrl).toBe("https://idp/login");
    expect(s.autoLogoutMinutes).toBe(0);
    expect(s.skipLoginPage).toBe(false);
  });
});

describe("updateSsoSettings", () => {
  it("trims every text field it is given and keeps the fields it is not", async () => {
    const out = await updateSsoSettings({ idpEntityId: "  https://other/entity  ", idpCertificate: "\nNEWCERT\n" });
    expect(out.idpEntityId).toBe("https://other/entity");
    expect(out.idpCertificate).toBe("NEWCERT");
    expect(out.idpLoginUrl).toBe(CONFIGURED.idpLoginUrl);
    expect(out.enabled).toBe(true);
    expect(h.saved).toEqual([out]);
  });

  it("clamps autoLogoutMinutes to 0..1440", async () => {
    expect((await updateSsoSettings({ autoLogoutMinutes: -5 })).autoLogoutMinutes).toBe(0);
    expect((await updateSsoSettings({ autoLogoutMinutes: 99999 })).autoLogoutMinutes).toBe(1440);
    expect((await updateSsoSettings({ autoLogoutMinutes: 30 })).autoLogoutMinutes).toBe(30);
  });

  it("can switch booleans off explicitly (false is not 'unset')", async () => {
    await store({ ...CONFIGURED, wantResponseSigned: true, skipLoginPage: true });
    const out = await updateSsoSettings({ enabled: false, wantResponseSigned: false, skipLoginPage: false });
    expect(out).toMatchObject({ enabled: false, wantResponseSigned: false, skipLoginPage: false });
  });

  it("drops the cached SAML client so the next login is built from the new config", async () => {
    await getSamlLoginUrl("relay");
    await getSamlLoginUrl("relay");
    expect(h.ctor).toHaveBeenCalledTimes(1);
    await updateSsoSettings({ idpLoginUrl: "https://idp2.example.com/login" });
    await getSamlLoginUrl("relay");
    expect(h.ctor).toHaveBeenCalledTimes(2);
    expect(lastConfig().entryPoint).toBe("https://idp2.example.com/login");
  });
});

describe("isAzureSsoConfiguredAsync", () => {
  it("is true only when enabled with an entity ID, login URL and certificate", async () => {
    expect(await isAzureSsoConfiguredAsync()).toBe(true);
    for (const missing of ["idpEntityId", "idpLoginUrl", "idpCertificate"]) {
      h.raw = { ...CONFIGURED, [missing]: "" };
      expect(await isAzureSsoConfiguredAsync()).toBe(false);
    }
    h.raw = { ...CONFIGURED, enabled: false };
    expect(await isAzureSsoConfiguredAsync()).toBe(false);
  });

  it("does not require the Application URL, although building the client does (suspicious, not pinned)", async () => {
    await store({ ...CONFIGURED, spEntityId: "" });
    expect(await isAzureSsoConfiguredAsync()).toBe(true);
    await expect(getSamlLoginUrl("r")).rejects.toMatchObject({ httpStatus: 400 });
  });
});

describe("getSamlLoginUrl (the SAML client)", () => {
  it("refuses with 400 while the IdP half is not configured", async () => {
    await store({ ...CONFIGURED, idpCertificate: "" });
    await expect(getSamlLoginUrl("r")).rejects.toMatchObject({ httpStatus: 400, message: "SAML SSO is not configured" });
    expect(h.ctor).not.toHaveBeenCalled();
  });

  it("refuses with 400 naming the Application URL when it is missing", async () => {
    await store({ ...CONFIGURED, spEntityId: "" });
    await expect(getSamlLoginUrl("r")).rejects.toThrow(/Application URL/);
  });

  it("builds issuer and callback from the Application URL with trailing slashes trimmed", async () => {
    await store({ ...CONFIGURED, spEntityId: "https://polaris.example.com///" });
    await getSamlLoginUrl("r");
    expect(lastConfig()).toMatchObject({
      issuer: "https://polaris.example.com",
      callbackUrl: "https://polaris.example.com/api/v1/auth/azure/callback",
      entryPoint: CONFIGURED.idpLoginUrl,
      idpIssuer: CONFIGURED.idpEntityId,
      idpCert: "CERT",
      wantAssertionsSigned: true,
      wantAuthnResponseSigned: false,
      validateInResponseTo: "ifPresent",
    });
  });

  it("logs out at the login URL when no logout URL is set, and at the logout URL when one is", async () => {
    await getSamlLoginUrl("r");
    expect(lastConfig().logoutUrl).toBe(CONFIGURED.idpLoginUrl);
    await store({ ...CONFIGURED, idpLogoutUrl: "https://idp.example.com/logout" });
    await getSamlLoginUrl("r");
    expect(lastConfig().logoutUrl).toBe("https://idp.example.com/logout");
  });

  it("requires a signed response when wantResponseSigned is on", async () => {
    await store({ ...CONFIGURED, wantResponseSigned: true });
    await getSamlLoginUrl("r");
    expect(lastConfig().wantAuthnResponseSigned).toBe(true);
  });

  it("passes the relay state through to the authorize URL", async () => {
    expect(await getSamlLoginUrl("nonce.%2Fassets")).toBe("https://idp.example.com/login?SAMLRequest=x");
    expect(h.authorize).toHaveBeenCalledWith("nonce.%2Fassets", undefined, {});
  });
});

describe("validateSamlResponse", () => {
  it("refuses with 401 when the library returns no profile", async () => {
    h.validatePost.mockResolvedValue({ profile: null });
    await expect(validateSamlResponse({ SAMLResponse: "x" })).rejects.toMatchObject({ httpStatus: 401 });
  });

  it("returns the profile of a fresh assertion", async () => {
    h.validatePost.mockResolvedValue({ profile: { ID: "_fresh-1", nameID: "a@example.com", issuer: "idp" } });
    await expect(validateSamlResponse({ SAMLResponse: "x" })).resolves.toMatchObject({ nameID: "a@example.com" });
  });
});

describe("getSamlLogoutUrl", () => {
  it("names the user by nameID + session index in email format", async () => {
    expect(await getSamlLogoutUrl("a@example.com", "_sess", "relay")).toBe("https://idp.example.com/logout?SAMLRequest=y");
    expect(h.logout).toHaveBeenCalledWith(
      { issuer: "", nameID: "a@example.com", nameIDFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress", sessionIndex: "_sess" },
      "relay",
      {},
    );
  });
});

describe("findOrProvisionSamlUser", () => {
  const EMAIL = "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress";
  const NAME = "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name";
  const DISPLAY = "http://schemas.microsoft.com/identity/claims/displayname";
  const OID = "http://schemas.microsoft.com/identity/claims/objectidentifier";
  const GROUPS = "http://schemas.microsoft.com/ws/2008/06/identity/claims/groups";

  const call = () => h.provision.mock.calls[0][0] as Record<string, unknown>;
  const profile = (p: Record<string, unknown>) => ({ issuer: "idp", ...p }) as never;

  it("hands the Azure claims to the shared provisioner under provider azure / azureOid", async () => {
    await findOrProvisionSamlUser(profile({
      nameID: "nameid@example.com", [EMAIL]: "jdoe@example.com", [NAME]: "Jane Doe", [OID]: "oid-123", [GROUPS]: ["g1", "g2"],
    }));
    expect(call()).toEqual({
      provider: "azure", externalIdField: "azureOid", externalId: "oid-123",
      usernameHint: "jdoe@example.com", displayName: "Jane Doe", email: "jdoe@example.com", groups: ["g1", "g2"],
    });
  });

  it("falls back email → mail → nameID, and displayname claim → displayName", async () => {
    await findOrProvisionSamlUser(profile({ nameID: "n@example.com", mail: "m@example.com", [DISPLAY]: "Disp", [OID]: "o" }));
    expect(call()).toMatchObject({ email: "m@example.com", usernameHint: "m@example.com", displayName: "Disp" });
    h.provision.mockClear();
    await findOrProvisionSamlUser(profile({ nameID: "n@example.com", [OID]: "o" }));
    expect(call()).toMatchObject({ email: "n@example.com", usernameHint: "n@example.com", displayName: null });
  });

  it("uses nameID as the stable id when the objectidentifier claim is absent", async () => {
    await findOrProvisionSamlUser(profile({ nameID: "n@example.com" }));
    expect(call().externalId).toBe("n@example.com");
  });

  it("refuses with 502 when the assertion carries no identifier at all", async () => {
    await expect(findOrProvisionSamlUser(profile({ nameID: "" }))).rejects.toMatchObject({ httpStatus: 502 });
    expect(h.provision).not.toHaveBeenCalled();
  });

  it("reads one group as a bare string, keeps only string groups from an array, and absent as none", async () => {
    await findOrProvisionSamlUser(profile({ nameID: "n", [OID]: "o", [GROUPS]: "only-group" }));
    expect(call().groups).toEqual(["only-group"]);
    h.provision.mockClear();
    await findOrProvisionSamlUser(profile({ nameID: "n", [OID]: "o", [GROUPS]: ["a", 7, null, "b"] }));
    expect(call().groups).toEqual(["a", "b"]);
    h.provision.mockClear();
    await findOrProvisionSamlUser(profile({ nameID: "n", [OID]: "o", [GROUPS]: "" }));
    expect(call().groups).toEqual([]);
    h.provision.mockClear();
    await findOrProvisionSamlUser(profile({ nameID: "n", [OID]: "o" }));
    expect(call().groups).toEqual([]);
  });
});
