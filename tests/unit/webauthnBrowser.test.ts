/**
 * tests/unit/webauthnBrowser.test.ts — public/js/webauthn.js
 *
 * The browser half of a passkey ceremony, hand-rolled rather than bundled from
 * @simplewebauthn/browser (the repo has no build step). The conversions are
 * the whole risk surface: base64url is NOT base64, and getting the `-`/`_`
 * substitution or the stripped padding wrong produces a credential the server
 * cannot verify — with an error that says "not recognized", which reads as a
 * wrong key rather than a client bug.
 *
 * `supported()` is pinned just as hard: it is what decides whether a login page
 * draws a passkey button at all, and Polaris genuinely supports installs
 * (plain HTTP on a lab VM) where the API exists and every call rejects.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(process.cwd(), "public", "js", "webauthn.js"), "utf-8");

interface Mod {
  supported: () => boolean;
  platformAuthenticatorAvailable: () => Promise<boolean>;
  create: (options: Record<string, unknown>) => Promise<Record<string, any>>;
  get: (options: Record<string, unknown>) => Promise<Record<string, any>>;
  describeError: (err: unknown) => string;
  guessDeviceName: () => string;
  bufferToBase64url: (b: ArrayBuffer) => string;
  base64urlToBuffer: (s: string) => ArrayBuffer;
}

function load(): Mod {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(SRC)();
  return (globalThis as Record<string, unknown>).PolarisWebAuthn as unknown as Mod;
}

/** The shape a browser hands back from navigator.credentials.create(). */
function fakeAttestation() {
  return {
    id: "Y3JlZC1pZA",
    rawId: new Uint8Array([1, 2, 3, 4]).buffer,
    type: "public-key",
    authenticatorAttachment: "platform",
    getClientExtensionResults: () => ({ credProps: { rk: true } }),
    response: {
      clientDataJSON: new Uint8Array([5, 6]).buffer,
      attestationObject: new Uint8Array([7, 8]).buffer,
      getTransports: () => ["internal", "hybrid"],
    },
  };
}

function fakeAssertion(withUserHandle: boolean) {
  return {
    id: "Y3JlZC1pZA",
    rawId: new Uint8Array([1, 2, 3, 4]).buffer,
    type: "public-key",
    authenticatorAttachment: "cross-platform",
    getClientExtensionResults: () => ({}),
    response: {
      authenticatorData: new Uint8Array([9]).buffer,
      clientDataJSON: new Uint8Array([10]).buffer,
      signature: new Uint8Array([11]).buffer,
      userHandle: withUserHandle ? new Uint8Array([12, 13]).buffer : null,
    },
  };
}

/** happy-dom exposes navigator.credentials through a getter, so assignment throws. */
function setCredentials(value: unknown) {
  Object.defineProperty(globalThis.navigator, "credentials", {
    value,
    configurable: true,
    writable: true,
  });
}

beforeEach(() => {
  const g = globalThis as Record<string, any>;
  g.window.PublicKeyCredential = function () {};
  g.window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = async () => true;
  g.window.isSecureContext = true;
  setCredentials({ create: vi.fn(), get: vi.fn() });
});

describe("base64url", () => {
  it("round-trips arbitrary bytes", () => {
    const mod = load();
    const bytes = new Uint8Array([0, 1, 250, 251, 252, 253, 254, 255, 127, 128]);
    const encoded = mod.bufferToBase64url(bytes.buffer);
    expect(new Uint8Array(mod.base64urlToBuffer(encoded))).toEqual(bytes);
  });

  it("emits the URL alphabet and no padding", () => {
    const mod = load();
    // 0xFB 0xFF 0xFE is "+//+" territory in standard base64.
    const encoded = mod.bufferToBase64url(new Uint8Array([251, 255, 254]).buffer);
    expect(encoded).not.toMatch(/[+/=]/);
  });

  it.each([1, 2, 3, 4, 5])("round-trips a %s-byte buffer — every padding remainder", (len) => {
    const mod = load();
    const bytes = new Uint8Array(Array.from({ length: len }, (_, i) => i * 37 % 256));
    expect(new Uint8Array(mod.base64urlToBuffer(mod.bufferToBase64url(bytes.buffer)))).toEqual(bytes);
  });

  it("decodes a value that arrived without padding", () => {
    const mod = load();
    // Exactly what the server sends: challenges are base64url with `=` stripped.
    expect(new Uint8Array(mod.base64urlToBuffer("AQIDBA"))).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it("round-trips an empty buffer", () => {
    const mod = load();
    expect(mod.bufferToBase64url(new Uint8Array([]).buffer)).toBe("");
  });
});

describe("supported", () => {
  it("is true in a secure context with the API present", () => {
    expect(load().supported()).toBe(true);
  });

  it("is FALSE on a plain-HTTP install, where every call would reject", () => {
    (globalThis as Record<string, any>).window.isSecureContext = false;
    expect(load().supported()).toBe(false);
  });

  it("is false in a browser without the API", () => {
    (globalThis as Record<string, any>).window.PublicKeyCredential = undefined;
    expect(load().supported()).toBe(false);
  });

  it("is false when the credentials container is missing", () => {
    setCredentials(undefined);
    expect(load().supported()).toBe(false);
  });
});

describe("create", () => {
  it("decodes the challenge, user id and excluded credentials before calling the browser", async () => {
    const mod = load();
    const create = vi.fn(async () => fakeAttestation());
    setCredentials({ create: create, get: vi.fn() });

    await mod.create({
      challenge: "AQIDBA",
      user: { id: "BQYH", name: "jsmith" },
      excludeCredentials: [{ id: "CAkK", transports: ["usb"] }],
      rp: { id: "polaris.example.com" },
    });

    const passed = create.mock.calls[0][0].publicKey;
    expect(new Uint8Array(passed.challenge)).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(new Uint8Array(passed.user.id)).toEqual(new Uint8Array([5, 6, 7]));
    expect(new Uint8Array(passed.excludeCredentials[0].id)).toEqual(new Uint8Array([8, 9, 10]));
    // Everything else rides through untouched.
    expect(passed.rp).toEqual({ id: "polaris.example.com" });
    expect(passed.user.name).toBe("jsmith");
  });

  it("returns the JSON shape the server verifies, transports included", async () => {
    const mod = load();
    (globalThis as Record<string, any>).navigator.credentials.create = vi.fn(async () => fakeAttestation());
    const result = await mod.create({ challenge: "AQIDBA", user: { id: "BQYH" } });
    expect(result).toMatchObject({
      id: "Y3JlZC1pZA",
      rawId: "AQIDBA",
      type: "public-key",
      authenticatorAttachment: "platform",
      response: { clientDataJSON: "BQY", attestationObject: "Bwg", transports: ["internal", "hybrid"] },
    });
  });

  it("tolerates an authenticator with no getTransports — an absent list is valid", async () => {
    const mod = load();
    const credential = fakeAttestation();
    delete (credential.response as Record<string, unknown>).getTransports;
    (globalThis as Record<string, any>).navigator.credentials.create = vi.fn(async () => credential);
    const result = await mod.create({ challenge: "AQIDBA", user: { id: "BQYH" } });
    expect(result.response.transports).toEqual([]);
  });

  it("throws when the browser returns nothing rather than sending an empty body", async () => {
    const mod = load();
    (globalThis as Record<string, any>).navigator.credentials.create = vi.fn(async () => null);
    await expect(mod.create({ challenge: "AQIDBA", user: { id: "BQYH" } })).rejects.toThrow(/No credential/);
  });
});

describe("get", () => {
  it("decodes the challenge and any named credentials", async () => {
    const mod = load();
    const get = vi.fn(async () => fakeAssertion(true));
    setCredentials({ create: vi.fn(), get: get });

    await mod.get({ challenge: "AQIDBA", allowCredentials: [{ id: "CAkK", transports: ["nfc"] }] });
    const passed = get.mock.calls[0][0].publicKey;
    expect(new Uint8Array(passed.challenge)).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(new Uint8Array(passed.allowCredentials[0].id)).toEqual(new Uint8Array([8, 9, 10]));
  });

  it("leaves allowCredentials absent for a usernameless ceremony", async () => {
    // The server omits it on purpose — naming credentials pre-auth would make
    // the endpoint an account-enumeration oracle — so the client must not
    // invent an empty array, which means something different to a browser.
    const mod = load();
    const get = vi.fn(async () => fakeAssertion(true));
    setCredentials({ create: vi.fn(), get: get });
    await mod.get({ challenge: "AQIDBA" });
    expect(get.mock.calls[0][0].publicKey.allowCredentials).toBeUndefined();
  });

  it("carries the user handle — it is how a discoverable credential names its account", async () => {
    const mod = load();
    (globalThis as Record<string, any>).navigator.credentials.get = vi.fn(async () => fakeAssertion(true));
    const result = await mod.get({ challenge: "AQIDBA" });
    expect(result.response.userHandle).toBe("DA0");
  });

  it("omits the user handle when the authenticator sent none", async () => {
    const mod = load();
    (globalThis as Record<string, any>).navigator.credentials.get = vi.fn(async () => fakeAssertion(false));
    const result = await mod.get({ challenge: "AQIDBA" });
    expect(result.response.userHandle).toBeUndefined();
  });
});

describe("describeError", () => {
  it("does not claim to know why a NotAllowedError happened", () => {
    // The browser deliberately uses one error for "user cancelled" and "no
    // matching credential"; a message that picked one would be a guess shown
    // to a person trying to get into their account.
    const message = load().describeError({ name: "NotAllowedError" });
    expect(message).toMatch(/cancelled or timed out/);
  });

  it("names the already-registered case, which is actionable", () => {
    expect(load().describeError({ name: "InvalidStateError" })).toMatch(/already registered/);
  });

  it("explains a SecurityError as a domain mismatch rather than a scary word", () => {
    expect(load().describeError({ name: "SecurityError" })).toMatch(/does not match the domain/);
  });

  it("falls back to the message, then to something generic", () => {
    expect(load().describeError({ name: "WeirdError", message: "it broke" })).toBe("it broke");
    expect(load().describeError(null)).toMatch(/failed/);
  });
});

describe("guessDeviceName", () => {
  it("offers an editable first guess rather than a blank field", () => {
    const name = load().guessDeviceName();
    expect(typeof name).toBe("string");
    expect(name.length).toBeGreaterThan(0);
  });
});
