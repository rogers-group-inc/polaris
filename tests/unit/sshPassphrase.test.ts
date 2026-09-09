/**
 * tests/unit/sshPassphrase.test.ts
 *
 * Encrypted-private-key support for SSH credentials.
 *
 * Only relevant for an OPERATOR-SUPPLIED key from their own escrow — a
 * Polaris-generated deployment key is never exported, so a passphrase on it
 * would just sit next to the key it protects. Without this, ssh2 fails at
 * parse time with "Encrypted private OpenSSH key detected, but no passphrase
 * given", which is not obviously a Polaris config problem from the operator's
 * side.
 */

import { describe, it, expect } from "vitest";
import ssh2 from "ssh2";
const sshUtils = ssh2.utils;

import { validateConfig, stripSecrets } from "../../src/services/credentialService.js";
import { generateEd25519Keypair, generateEncryptedEd25519Keypair } from "../../src/utils/sshKeygen.js";

const PASSPHRASE = "correct horse battery staple";
// Through the shared helper, not ssh2 directly: its ed25519 generator emits an
// unparseable private key about one call in three, which made this file flake
// at module load. See src/utils/sshKeygen.ts.
const ENCRYPTED_PAIR = generateEncryptedEd25519Keypair(PASSPHRASE);
const PLAIN_PAIR = generateEd25519Keypair("");
const ENCRYPTED = { private: ENCRYPTED_PAIR.privateKey, public: ENCRYPTED_PAIR.publicKey };
const PLAIN = { private: PLAIN_PAIR.privateKey, public: PLAIN_PAIR.publicKey };

describe("ssh2 encrypted-key behaviour (the reason this feature exists)", () => {
  it("refuses an encrypted key with no passphrase, and accepts it with one", () => {
    const without = sshUtils.parseKey(ENCRYPTED.private);
    expect(without).toBeInstanceOf(Error);
    expect((without as Error).message).toMatch(/passphrase/i);

    const with_ = sshUtils.parseKey(ENCRYPTED.private, PASSPHRASE);
    expect(with_).not.toBeInstanceOf(Error);
    expect((with_ as any).type).toBe("ssh-ed25519");
  });

  it("rejects a wrong passphrase rather than silently producing a bad key", () => {
    const bad = sshUtils.parseKey(ENCRYPTED.private, "not-the-passphrase");
    expect(bad).toBeInstanceOf(Error);
  });
});

describe("validateSshConfig — passphrase", () => {
  const base = { username: "polaris-agent" };

  it("accepts a passphrase alongside a private key", () => {
    expect(() =>
      validateConfig("ssh", { ...base, privateKey: ENCRYPTED.private, passphrase: PASSPHRASE }),
    ).not.toThrow();
  });

  it("accepts a private key with no passphrase (the unencrypted case)", () => {
    expect(() => validateConfig("ssh", { ...base, privateKey: PLAIN.private })).not.toThrow();
  });

  it("rejects a passphrase with no key, pointing at the fix", () => {
    // Catching it here beats a connect-time parse error the operator has to
    // decode.
    expect(() => validateConfig("ssh", { ...base, password: "pw", passphrase: PASSPHRASE }))
      .toThrow(/only applies to a private key/i);
  });

  it("still requires a password or a key", () => {
    expect(() => validateConfig("ssh", { ...base, passphrase: PASSPHRASE }))
      .toThrow(/password or a private key/i);
  });

  it("treats an empty passphrase as absent", () => {
    expect(() => validateConfig("ssh", { ...base, password: "pw", passphrase: "" })).not.toThrow();
  });
});

describe("masking", () => {
  it("masks the passphrase like every other SSH secret", () => {
    const out = stripSecrets({
      id: "x", name: "n", type: "ssh",
      config: {
        username: "u",
        privateKey: ENCRYPTED.private,
        passphrase: PASSPHRASE,
        publicKey: "ssh-ed25519 AAAA= c",
      },
      createdAt: new Date(), updatedAt: new Date(),
    });
    expect(out.config.passphrase).not.toBe(PASSPHRASE);
    expect(String(out.config.passphrase)).toMatch(/^•+$/);
    expect(out.config.privateKey).not.toContain("PRIVATE KEY");
    // publicKey is deliberately NOT a secret — see windowsSshOnboardingService.
    expect(out.config.publicKey).toBe("ssh-ed25519 AAAA= c");
  });
});

describe("connect options", () => {
  /**
   * Mirrors the branch in remoteExec.withSshClient / monitoringService.probeSsh
   * without opening a socket: passphrase rides ONLY the key path, and only when
   * non-empty (ssh2 rejects an empty-string passphrase on a plain key).
   */
  function connectOpts(config: Record<string, unknown>) {
    const password = typeof config.password === "string" ? config.password : "";
    const privateKey = typeof config.privateKey === "string" ? config.privateKey : "";
    const passphrase = typeof config.passphrase === "string" ? config.passphrase : "";
    const opts: any = {};
    if (privateKey) {
      opts.privateKey = privateKey;
      if (passphrase) opts.passphrase = passphrase;
    } else {
      opts.password = password;
    }
    return opts;
  }

  it("passes the passphrase through with the key", () => {
    const o = connectOpts({ privateKey: ENCRYPTED.private, passphrase: PASSPHRASE });
    expect(o.passphrase).toBe(PASSPHRASE);
    // And those exact options parse — the real connect would authenticate.
    expect(sshUtils.parseKey(o.privateKey, o.passphrase)).not.toBeInstanceOf(Error);
  });

  it("omits an empty passphrase rather than passing ''", () => {
    const o = connectOpts({ privateKey: PLAIN.private, passphrase: "" });
    expect("passphrase" in o).toBe(false);
    expect(sshUtils.parseKey(o.privateKey)).not.toBeInstanceOf(Error);
  });

  it("never attaches a passphrase to the password path", () => {
    const o = connectOpts({ password: "pw", passphrase: "stray" });
    expect(o.password).toBe("pw");
    expect("passphrase" in o).toBe(false);
  });
});
