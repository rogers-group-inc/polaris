/**
 * tests/unit/sshKeygen.test.ts
 *
 * The helper exists because ssh2's ed25519 generator emits a private key its
 * own parser rejects about one call in three. So the assertion that matters is
 * a volume one: generate many keys and every single one must parse. Before the
 * retry, a loop of thirty would have failed roughly ten times.
 */

import { describe, it, expect } from "vitest";
import ssh2 from "ssh2";
import {
  generateEd25519Keypair,
  generateEncryptedEd25519Keypair,
  KEYGEN_ATTEMPTS,
  SshKeygenError,
} from "../../src/utils/sshKeygen.js";

const sshUtils = ssh2.utils;

describe("generateEd25519Keypair", () => {
  it("returns a private key that parses, every time", () => {
    // The whole point. A single call would pass ~two thirds of the time even
    // with the bug, so the count is the test.
    for (let i = 0; i < 30; i += 1) {
      const pair = generateEd25519Keypair("polaris-test");
      const parsed = sshUtils.parseKey(pair.privateKey);
      expect(parsed).not.toBeInstanceOf(Error);
    }
  });

  it("returns an authorized_keys-shaped public half carrying the comment", () => {
    const pair = generateEd25519Keypair("polaris-agent-deploy");
    expect(pair.publicKey.startsWith("ssh-ed25519 ")).toBe(true);
    expect(pair.publicKey).toContain("polaris-agent-deploy");
    // Trimmed: it is written straight into an authorized_keys line.
    expect(pair.publicKey).toBe(pair.publicKey.trim());
  });

  it("emits an OpenSSH-format private key", () => {
    const pair = generateEd25519Keypair("x");
    expect(pair.privateKey).toContain("BEGIN OPENSSH PRIVATE KEY");
  });

  it("accepts an empty comment", () => {
    const pair = generateEd25519Keypair("");
    expect(sshUtils.parseKey(pair.privateKey)).not.toBeInstanceOf(Error);
  });

  it("produces a different key each call", () => {
    expect(generateEd25519Keypair("a").privateKey).not.toBe(generateEd25519Keypair("a").privateKey);
  });
});

describe("generateEncryptedEd25519Keypair", () => {
  const PASSPHRASE = "correct horse battery staple";

  // Fewer iterations than the plain case and an explicit budget: encrypting
  // the private half runs a bcrypt KDF, so each call costs about a second and
  // twenty of them blow the default 5s timeout.
  it("returns a key that parses WITH the passphrase, every time", () => {
    for (let i = 0; i < 5; i += 1) {
      const pair = generateEncryptedEd25519Keypair(PASSPHRASE);
      expect(sshUtils.parseKey(pair.privateKey, PASSPHRASE)).not.toBeInstanceOf(Error);
    }
  }, 30_000);

  it("still refuses to parse without the passphrase — it is genuinely encrypted", () => {
    const pair = generateEncryptedEd25519Keypair(PASSPHRASE);
    expect(sshUtils.parseKey(pair.privateKey)).toBeInstanceOf(Error);
    expect(sshUtils.parseKey(pair.privateKey, "wrong")).toBeInstanceOf(Error);
  });
});

describe("failure contract", () => {
  it("allows enough attempts that a genuine failure is vanishingly unlikely", () => {
    // At the observed ~1-in-3 failure rate, five attempts leaves about 1 in 250.
    expect(KEYGEN_ATTEMPTS).toBeGreaterThanOrEqual(3);
  });

  it("carries a distinguishable error type so callers can map it to a 500", () => {
    const err = new SshKeygenError(5, "Malformed OpenSSH private key");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("SshKeygenError");
    expect(err.message).toContain("5 attempts");
    expect(err.message).toContain("Malformed");
  });
});
