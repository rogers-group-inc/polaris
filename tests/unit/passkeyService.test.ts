/**
 * tests/unit/passkeyService.test.ts
 *
 * The passkey policy, the RP plumbing around it, and the guards on the
 * ceremonies. Prisma and @simplewebauthn/server are both mocked: this file is
 * about the decisions Polaris makes AROUND a verification, not about whether
 * the library verifies a signature correctly (it has its own suite, and a
 * hand-rolled fixture assertion here would only pin our mock).
 *
 * The cases that matter:
 *   - mode gates: what "login", "second-factor", "both" and "off" each refuse;
 *   - the failure posture — a settings read that throws must resolve to OFF,
 *     because a credential signing someone in is the last decision that should
 *     be made from an unreadable Setting row;
 *   - a passwordless login that names an unknown credential, an SSO account,
 *     or a rolled-back counter must all fail with the SAME message;
 *   - the second-factor step must be bound to the account that passed the
 *     password, or any passkey-holder could finish somebody else's login.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => ({
  prisma: {
    setting: { findUnique: vi.fn(), upsert: vi.fn() },
    userPasskey: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
      count: vi.fn(),
      groupBy: vi.fn(),
    },
  },
}));

const webauthn = vi.hoisted(() => ({
  generateRegistrationOptions: vi.fn(),
  verifyRegistrationResponse: vi.fn(),
  generateAuthenticationOptions: vi.fn(),
  verifyAuthenticationResponse: vi.fn(),
}));
vi.mock("@simplewebauthn/server", () => webauthn);

import {
  getPasskeySettings,
  savePasskeySettings,
  invalidatePasskeyCache,
  defaultPasskeySettings,
  normalizeRpId,
  passkeyLoginEnabled,
  passkeySecondFactorEnabled,
  getPasskeyAvailability,
  requireRelyingParty,
  startRegistration,
  finishRegistration,
  startLogin,
  startSecondFactor,
  finishAuthentication,
  listPasskeys,
  renamePasskey,
  deletePasskey,
  deleteAllPasskeys,
  countPasskeysByUser,
  userHasPasskey,
  PASSKEY_SETTING_KEY,
} from "../../src/services/passkeyService.js";
import { prisma } from "../../src/db.js";
import { AppError } from "../../src/utils/errors.js";
import * as challenge from "../../src/utils/webauthnChallenge.js";

type Mock = ReturnType<typeof vi.fn>;
const findSetting = prisma.setting.findUnique as unknown as Mock;
const upsertSetting = prisma.setting.upsert as unknown as Mock;
const pk = prisma.userPasskey as unknown as Record<string, Mock>;

/** An HTTPS request from a real hostname — the ordinary case. */
const req = { protocol: "https", headers: { host: "polaris.example.com" } };

const localUser = { id: "user-1", username: "jsmith", displayName: "J Smith", authProvider: "local" };

beforeEach(() => {
  vi.clearAllMocks();
  invalidatePasskeyCache();
  challenge._reset();
  findSetting.mockResolvedValue(null);
  upsertSetting.mockImplementation(async ({ create }: { create: { value: unknown } }) => ({ value: create.value }));
  pk.findMany.mockResolvedValue([]);
  pk.findUnique.mockResolvedValue(null);
  pk.count.mockResolvedValue(0);
});

describe("settings", () => {
  it("defaults to both modes with user verification required", () => {
    expect(defaultPasskeySettings()).toEqual({ mode: "both", rpId: "", requireUserVerification: true });
  });

  it("defaults to enabled, because switching passkeys on refuses nothing", async () => {
    // Passwords keep working and registration is opt-in per user, so an
    // upgrade that starts offering passkeys denies no one a login.
    await expect(getPasskeySettings()).resolves.toMatchObject({ mode: "both" });
  });

  it("reads the row under the documented key", async () => {
    await getPasskeySettings();
    expect(findSetting).toHaveBeenCalledWith({ where: { key: PASSKEY_SETTING_KEY } });
  });

  it("falls back to OFF when the read throws", async () => {
    // The opposite of the password policy's fallback, and deliberately: this
    // setting decides whether a credential may sign someone in, and that is not
    // a decision to make from an unreadable row. Passwords still work.
    findSetting.mockRejectedValue(new Error("connection terminated"));
    await expect(getPasskeySettings()).resolves.toMatchObject({ mode: "off" });
  });

  it("merges a partial save", async () => {
    const saved = await savePasskeySettings({ mode: "second-factor" });
    expect(saved).toEqual({ mode: "second-factor", rpId: "", requireUserVerification: true });
  });

  it("ignores a mode it does not recognize", async () => {
    expect((await savePasskeySettings({ mode: "whatever" as never })).mode).toBe("both");
  });
});

describe("normalizeRpId", () => {
  it("accepts a bare domain unchanged", () => {
    expect(normalizeRpId("example.com")).toBe("example.com");
  });

  it.each([
    ["https://polaris.example.com", "polaris.example.com"],
    ["http://polaris.example.com/", "polaris.example.com"],
    ["polaris.example.com:8443", "polaris.example.com"],
    ["  Polaris.Example.COM  ", "polaris.example.com"],
    ["example.com.", "example.com"],
    ["https://example.com/path?x=1", "example.com"],
  ])("normalizes %j to %j — an operator pasting a URL is expected input", (input, expected) => {
    expect(normalizeRpId(input)).toBe(expected);
  });
});

describe("mode predicates", () => {
  it.each([
    ["off", false, false],
    ["login", true, false],
    ["second-factor", false, true],
    ["both", true, true],
  ])("%s → login %s, second factor %s", (mode, login, second) => {
    const s = { ...defaultPasskeySettings(), mode: mode as never };
    expect(passkeyLoginEnabled(s)).toBe(login);
    expect(passkeySecondFactorEnabled(s)).toBe(second);
  });
});

describe("getPasskeyAvailability", () => {
  it("reports both entry points on an HTTPS host in 'both' mode", async () => {
    await expect(getPasskeyAvailability(req)).resolves.toEqual({
      loginEnabled: true,
      secondFactorEnabled: true,
      mode: "both",
      unavailableReason: null,
      rpId: "polaris.example.com",
    });
  });

  it("reports neither when the mode is off, without inventing a reason", async () => {
    findSetting.mockResolvedValue({ value: { mode: "off" } });
    const a = await getPasskeyAvailability(req);
    expect(a.loginEnabled).toBe(false);
    expect(a.secondFactorEnabled).toBe(false);
    expect(a.unavailableReason).toBeNull();
  });

  it("explains itself on a plain-HTTP install rather than offering a dead button", async () => {
    const a = await getPasskeyAvailability({ protocol: "http", headers: { host: "polaris.example.com" } });
    expect(a.loginEnabled).toBe(false);
    expect(a.unavailableReason).toMatch(/HTTPS/);
    expect(a.rpId).toBeNull();
  });

  it("names TRUST_PROXY when a proxy said https and Express did not believe it", async () => {
    // The commonest shape of "passkeys don't work": TLS terminated at nginx /
    // Caddy / Traefik / NPM with TRUST_PROXY unset, which reads in here exactly
    // like a plain-HTTP lab VM. The header is read for the SENTENCE only — the
    // request is still refused.
    const a = await getPasskeyAvailability({
      protocol: "http",
      headers: { host: "polaris.example.com", "x-forwarded-proto": "https" },
    });
    expect(a.loginEnabled).toBe(false);
    expect(a.rpId).toBeNull();
    expect(a.unavailableReason).toMatch(/TRUST_PROXY/);
  });

  it("prefers Express's req.get('host') when present", async () => {
    const a = await getPasskeyAvailability({
      protocol: "https",
      headers: {},
      get: (name: string) => (name === "host" ? "other.example.com" : undefined),
    });
    expect(a.rpId).toBe("other.example.com");
  });
});

describe("requireRelyingParty", () => {
  it("throws the operator-facing reason when the RP cannot be resolved", async () => {
    await expect(requireRelyingParty({ protocol: "https", headers: { host: "10.0.0.5" } }))
      .rejects.toThrow(/domain name/);
  });
});

describe("startRegistration", () => {
  beforeEach(() => {
    webauthn.generateRegistrationOptions.mockResolvedValue({ challenge: "Y2hhbA" });
  });

  it("refuses an SSO account — its credentials belong to the identity provider", async () => {
    await expect(startRegistration({ ...localUser, authProvider: "azure" }, req))
      .rejects.toThrow(/identity provider/);
  });

  it("refuses while passkeys are switched off", async () => {
    findSetting.mockResolvedValue({ value: { mode: "off" } });
    await expect(startRegistration(localUser, req)).rejects.toThrow(/disabled/);
  });

  it("demands a discoverable credential, so usernameless login is possible", async () => {
    await startRegistration(localUser, req);
    expect(webauthn.generateRegistrationOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        rpID: "polaris.example.com",
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
      }),
    );
  });

  it("relaxes user verification to 'preferred' when the operator turned it off", async () => {
    findSetting.mockResolvedValue({ value: { requireUserVerification: false } });
    await startRegistration(localUser, req);
    expect(webauthn.generateRegistrationOptions.mock.calls[0][0].authenticatorSelection.userVerification)
      .toBe("preferred");
  });

  it("excludes the credentials this account already holds", async () => {
    pk.findMany.mockResolvedValue([{ credentialId: "cred-a", transports: ["internal"] }]);
    await startRegistration(localUser, req);
    expect(webauthn.generateRegistrationOptions.mock.calls[0][0].excludeCredentials)
      .toEqual([{ id: "cred-a", transports: ["internal"] }]);
  });

  it("keys the user handle on the account id, so re-registering replaces rather than stacks", async () => {
    await startRegistration(localUser, req);
    expect(new TextDecoder().decode(webauthn.generateRegistrationOptions.mock.calls[0][0].userID))
      .toBe("user-1");
  });

  it("issues a ceremony token the browser must hand back", async () => {
    const { token } = await startRegistration(localUser, req);
    expect(token).toHaveLength(64);
  });
});

describe("finishRegistration", () => {
  const verified = {
    verified: true,
    registrationInfo: {
      credential: { id: "cred-new", publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ["internal"] },
      credentialDeviceType: "multiDevice",
      credentialBackedUp: true,
      aaguid: "aaguid-1",
    },
  };

  async function startedToken() {
    webauthn.generateRegistrationOptions.mockResolvedValue({ challenge: "Y2hhbA" });
    return (await startRegistration(localUser, req)).token;
  }

  beforeEach(() => {
    webauthn.verifyRegistrationResponse.mockResolvedValue(verified);
    pk.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "row-1",
      name: data.name,
      createdAt: new Date(),
      lastUsedAt: null,
      deviceType: data.deviceType,
      backedUp: data.backedUp,
      transports: data.transports,
    }));
  });

  it("stores the credential with the counter and sync state the authenticator reported", async () => {
    const token = await startedToken();
    await finishRegistration({ user: localUser, token, response: {} as never, name: "Work laptop" });
    expect(pk.create.mock.calls[0][0].data).toMatchObject({
      userId: "user-1",
      credentialId: "cred-new",
      counter: 0n,
      name: "Work laptop",
      deviceType: "multiDevice",
      backedUp: true,
    });
  });

  it("verifies against the origin and RP the ceremony was ISSUED for", async () => {
    // Not against whatever the second request claims to be — re-deriving would
    // turn a mismatch that should fail into a silent success.
    const token = await startedToken();
    await finishRegistration({ user: localUser, token, response: {} as never, name: "x" });
    expect(webauthn.verifyRegistrationResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedOrigin: "https://polaris.example.com",
        expectedRPID: "polaris.example.com",
        expectedChallenge: "Y2hhbA",
      }),
    );
  });

  it("refuses a token that was never issued", async () => {
    await expect(finishRegistration({ user: localUser, token: "nope", response: {} as never, name: "x" }))
      .rejects.toThrow(/expired or was already used/);
  });

  it("refuses a token belonging to a different account", async () => {
    const token = await startedToken();
    await expect(finishRegistration({
      user: { ...localUser, id: "user-2" }, token, response: {} as never, name: "x",
    })).rejects.toThrow(/expired or was already used/);
  });

  it("surfaces the library's reason when verification throws — that is what an operator debugs a proxy with", async () => {
    const token = await startedToken();
    webauthn.verifyRegistrationResponse.mockRejectedValue(new Error("Unexpected registration response origin"));
    await expect(finishRegistration({ user: localUser, token, response: {} as never, name: "x" }))
      .rejects.toThrow(/Unexpected registration response origin/);
  });

  it("refuses a credential already registered to someone else", async () => {
    const token = await startedToken();
    pk.findUnique.mockResolvedValue({ userId: "user-2" });
    await expect(finishRegistration({ user: localUser, token, response: {} as never, name: "x" }))
      .rejects.toThrow(/another account/);
  });

  it("refuses a credential already on this account, and says which", async () => {
    const token = await startedToken();
    pk.findUnique.mockResolvedValue({ userId: "user-1" });
    await expect(finishRegistration({ user: localUser, token, response: {} as never, name: "x" }))
      .rejects.toThrow(/already registered on this account/);
  });

  it("falls back to a name rather than storing an empty one", async () => {
    const token = await startedToken();
    await finishRegistration({ user: localUser, token, response: {} as never, name: "   " });
    expect(pk.create.mock.calls[0][0].data.name).toBe("Passkey");
  });
});

describe("startLogin", () => {
  beforeEach(() => {
    webauthn.generateAuthenticationOptions.mockResolvedValue({ challenge: "Y2hhbA" });
  });

  it("refuses when passkeys are a second factor only", async () => {
    findSetting.mockResolvedValue({ value: { mode: "second-factor" } });
    await expect(startLogin(req)).rejects.toThrow(/second factor only/);
  });

  it("names NO credentials — the endpoint must not be an account-enumeration oracle", async () => {
    await startLogin(req);
    expect(webauthn.generateAuthenticationOptions.mock.calls[0][0].allowCredentials).toBeUndefined();
  });
});

describe("startSecondFactor", () => {
  beforeEach(() => {
    webauthn.generateAuthenticationOptions.mockResolvedValue({ challenge: "Y2hhbA" });
  });

  it("refuses when passkeys are sign-in only", async () => {
    findSetting.mockResolvedValue({ value: { mode: "login" } });
    await expect(startSecondFactor(req, "user-1")).rejects.toThrow(/not enabled as a second factor/);
  });

  it("refuses for an account with no passkeys", async () => {
    pk.findMany.mockResolvedValue([]);
    await expect(startSecondFactor(req, "user-1")).rejects.toThrow(/no passkeys registered/);
  });

  it("DOES name the credentials here — the caller already proved the password", async () => {
    pk.findMany.mockResolvedValue([{ credentialId: "cred-a", transports: ["usb"] }]);
    await startSecondFactor(req, "user-1");
    expect(webauthn.generateAuthenticationOptions.mock.calls[0][0].allowCredentials)
      .toEqual([{ id: "cred-a", transports: ["usb"] }]);
  });
});

describe("finishAuthentication", () => {
  const stored = {
    id: "row-1",
    userId: "user-1",
    credentialId: "cred-a",
    publicKey: Buffer.from([1, 2, 3]),
    counter: 5n,
    transports: ["internal"],
    name: "Work laptop",
    user: { id: "user-1", username: "jsmith", authProvider: "local" },
  };

  async function loginToken() {
    webauthn.generateAuthenticationOptions.mockResolvedValue({ challenge: "Y2hhbA" });
    return (await startLogin(req)).token;
  }

  beforeEach(() => {
    webauthn.verifyAuthenticationResponse.mockResolvedValue({
      verified: true,
      authenticationInfo: {
        credentialID: "cred-a",
        newCounter: 6,
        userVerified: true,
        credentialDeviceType: "singleDevice",
        credentialBackedUp: false,
        origin: "https://polaris.example.com",
        rpID: "polaris.example.com",
      },
    });
    pk.update.mockResolvedValue({});
  });

  it("resolves the account from the credential and stamps last-used", async () => {
    const token = await loginToken();
    pk.findUnique.mockResolvedValue(stored);
    await expect(finishAuthentication({ token, response: { id: "cred-a" } as never, purpose: "login" }))
      .resolves.toEqual({ userId: "user-1", username: "jsmith", passkeyId: "row-1", passkeyName: "Work laptop" });
    expect(pk.update.mock.calls[0][0].data).toMatchObject({ counter: 6n, backedUp: false, deviceType: "singleDevice" });
  });

  it("refuses an expired or replayed ceremony", async () => {
    await expect(finishAuthentication({ token: "nope", response: {} as never, purpose: "login" }))
      .rejects.toThrow(/expired/);
  });

  it("gives an unknown credential the same answer a bad signature gets", async () => {
    const token = await loginToken();
    pk.findUnique.mockResolvedValue(null);
    await expect(finishAuthentication({ token, response: { id: "cred-x" } as never, purpose: "login" }))
      .rejects.toThrow(/was not recognized/);
  });

  it("refuses a credential whose account has since become SSO-managed", async () => {
    const token = await loginToken();
    pk.findUnique.mockResolvedValue({ ...stored, user: { ...stored.user, authProvider: "azure" } });
    await expect(finishAuthentication({ token, response: { id: "cred-a" } as never, purpose: "login" }))
      .rejects.toThrow(/was not recognized/);
  });

  it("refuses a counter that went backwards — the one clone signal WebAuthn gives", async () => {
    const token = await loginToken();
    pk.findUnique.mockResolvedValue(stored); // stored counter 5
    webauthn.verifyAuthenticationResponse.mockResolvedValue({
      verified: true,
      authenticationInfo: {
        credentialID: "cred-a", newCounter: 4, userVerified: true,
        credentialDeviceType: "singleDevice", credentialBackedUp: false,
        origin: "https://polaris.example.com", rpID: "polaris.example.com",
      },
    });
    await expect(finishAuthentication({ token, response: { id: "cred-a" } as never, purpose: "login" }))
      .rejects.toThrow(/was not recognized/);
  });

  it("accepts a counter pinned at zero — most platform authenticators never move it", async () => {
    const token = await loginToken();
    pk.findUnique.mockResolvedValue({ ...stored, counter: 0n });
    webauthn.verifyAuthenticationResponse.mockResolvedValue({
      verified: true,
      authenticationInfo: {
        credentialID: "cred-a", newCounter: 0, userVerified: true,
        credentialDeviceType: "multiDevice", credentialBackedUp: true,
        origin: "https://polaris.example.com", rpID: "polaris.example.com",
      },
    });
    await expect(finishAuthentication({ token, response: { id: "cred-a" } as never, purpose: "login" }))
      .resolves.toMatchObject({ userId: "user-1" });
  });

  it("binds the second-factor step to the account that passed the password", async () => {
    // Without this, anyone holding ANY passkey on the install could finish
    // someone else's half-completed login.
    webauthn.generateAuthenticationOptions.mockResolvedValue({ challenge: "Y2hhbA" });
    pk.findMany.mockResolvedValue([{ credentialId: "cred-a", transports: [] }]);
    const { token } = await startSecondFactor(req, "user-1");
    pk.findUnique.mockResolvedValue({ ...stored, userId: "user-2" });
    await expect(finishAuthentication({
      token, response: { id: "cred-a" } as never, purpose: "mfa", expectUserId: "user-2",
    })).rejects.toThrow(/does not belong to this login/);
  });

  it("refuses a login-purpose token at the second-factor step", async () => {
    const token = await loginToken();
    await expect(finishAuthentication({ token, response: {} as never, purpose: "mfa" }))
      .rejects.toThrow(/expired/);
  });

  it("refuses everything once passkeys are switched off", async () => {
    const token = await loginToken();
    invalidatePasskeyCache();
    findSetting.mockResolvedValue({ value: { mode: "off" } });
    await expect(finishAuthentication({ token, response: {} as never, purpose: "login" }))
      .rejects.toThrow(/disabled/);
  });
});

describe("credential management", () => {
  it("lists a user's credentials oldest first", async () => {
    pk.findMany.mockResolvedValue([]);
    await listPasskeys("user-1");
    expect(pk.findMany.mock.calls[0][0]).toMatchObject({ where: { userId: "user-1" }, orderBy: { createdAt: "asc" } });
  });

  it("counts per user in ONE query rather than per row", async () => {
    // At a few hundred accounts the N+1 would be the most expensive thing on
    // the users page.
    pk.groupBy.mockResolvedValue([{ userId: "user-1", _count: { _all: 2 } }]);
    await expect(countPasskeysByUser(["user-1", "user-2"])).resolves.toEqual(new Map([["user-1", 2]]));
    expect(pk.groupBy).toHaveBeenCalledTimes(1);
  });

  it("does not query at all for an empty id list", async () => {
    await expect(countPasskeysByUser([])).resolves.toEqual(new Map());
    expect(pk.groupBy).not.toHaveBeenCalled();
  });

  it("scopes a rename by owner, so another user's id only ever 404s", async () => {
    pk.findFirst.mockResolvedValue(null);
    await expect(renamePasskey("user-1", "row-9", "New name")).rejects.toThrow(AppError);
    expect(pk.findFirst.mock.calls[0][0].where).toEqual({ id: "row-9", userId: "user-1" });
  });

  it("refuses an empty rename", async () => {
    await expect(renamePasskey("user-1", "row-1", "  ")).rejects.toThrow(/name is required/);
  });

  it("scopes a delete by owner too, and returns the name for the audit Event", async () => {
    pk.findFirst.mockResolvedValue({ id: "row-1", name: "Work laptop" });
    pk.delete.mockResolvedValue({});
    await expect(deletePasskey("user-1", "row-1")).resolves.toBe("Work laptop");
  });

  it("reports how many an admin revoke removed", async () => {
    pk.deleteMany.mockResolvedValue({ count: 3 });
    await expect(deleteAllPasskeys("user-1")).resolves.toBe(3);
  });

  it("answers whether an account holds any", async () => {
    pk.count.mockResolvedValue(0);
    await expect(userHasPasskey("user-1")).resolves.toBe(false);
    pk.count.mockResolvedValue(2);
    await expect(userHasPasskey("user-1")).resolves.toBe(true);
  });
});
