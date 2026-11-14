/**
 * tests/unit/windowsSshOnboardingService.test.ts — the own suite for
 * src/services/windowsSshOnboardingService.ts (the SSH Deployment card:
 * business rules 72 / 76 for the scripts it serves, 166 for key rotation;
 * CQ-T010).
 *
 * Complements windowsSshOnboarding.test.ts (which generates a REAL ed25519 key
 * and round-trips it through ssh2). This file mocks the keygen and the
 * credential store so it can pin what that one cannot reach cheaply:
 *   - parseConfig through the setting store: the pre-Linux flat shape folded
 *     into the windows slot, junk tolerated, the retired-key cap;
 *   - getOnboardingState: a dangling credential id reads as not generated,
 *     the public key preferred from whichever row exists, the fingerprint;
 *   - saveOnboardingConfig: platform / mode validation, per-platform username
 *     rules, the mode's default name, the no-change path (no write, no Event),
 *     the managed credential's username kept in step;
 *   - generateKeypair: SshKeygenError → 500 before any write, first generate
 *     vs rotation (both platforms, same key, config REPLACED), the retired
 *     list (newest first, de-duplicated, capped at 10), the warning Event,
 *     name suffixing and its exhaustion 409;
 *   - getOnboardingScript: the guards and the builder each kind / platform
 *     dispatches to, with its arguments (the server IP feeds the endpoint
 *     firewall rule, rule 76).
 *
 * No ssh, no PowerShell, no WinRM: nothing here opens a connection.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";

const h = vi.hoisted(() => ({
  creds: new Map<string, { id: string; name: string; type: string; config: Record<string, unknown> }>(),
  seq: 0,
  keygen: vi.fn(),
  createCredential: vi.fn(),
  setting: { value: undefined as unknown },
}));

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) => import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
vi.mock("../../src/utils/sshKeygen.js", async (orig) => {
  const real = await orig<typeof import("../../src/utils/sshKeygen.js")>();
  return { ...real, generateEd25519Keypair: h.keygen };
});
vi.mock("../../src/services/credentialService.js", async (orig) => {
  const real = await orig<typeof import("../../src/services/credentialService.js")>();
  const { AppError } = await import("../../src/utils/errors.js");
  return {
    ...real,
    getCredential: vi.fn(async (id: string, opts?: { revealSecrets?: boolean }) => {
      const c = h.creds.get(id);
      if (!c) throw new AppError(404, "Credential not found");
      if (opts?.revealSecrets) return { ...c, config: { ...c.config } };
      const { privateKey: _p, password: _w, ...rest } = c.config;
      return { ...c, config: rest };
    }),
    createCredential: h.createCredential,
  };
});
vi.mock("../../src/services/sshOnboardingScript.js", async (orig) => {
  const real = await orig<typeof import("../../src/services/sshOnboardingScript.js")>();
  return {
    ...real,
    buildWindowsOnboardingScript: vi.fn(real.buildWindowsOnboardingScript),
    buildWindowsOnboardingDetectionScript: vi.fn(real.buildWindowsOnboardingDetectionScript),
    buildLinuxOnboardingScript: vi.fn(real.buildLinuxOnboardingScript),
    buildLinuxOnboardingDetectionScript: vi.fn(real.buildLinuxOnboardingDetectionScript),
  };
});
vi.mock("../../src/services/sshOffboardingScript.js", async (orig) => {
  const real = await orig<typeof import("../../src/services/sshOffboardingScript.js")>();
  return {
    ...real,
    buildWindowsOffboardingScript: vi.fn(real.buildWindowsOffboardingScript),
    buildLinuxOffboardingScript: vi.fn(real.buildLinuxOffboardingScript),
  };
});

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
import { AppError } from "../../src/utils/errors.js";
import { SshKeygenError } from "../../src/utils/sshKeygen.js";
import * as onboard from "../../src/services/sshOnboardingScript.js";
import * as offboard from "../../src/services/sshOffboardingScript.js";
import {
  MANAGED_CREDENTIAL_NAMES,
  _invalidateCache,
  generateKeypair,
  getOnboardingScript,
  getOnboardingState,
  saveOnboardingConfig,
  sshPublicKeyFingerprint,
} from "../../src/services/windowsSshOnboardingService.js";

/** A well-formed ssh-ed25519 authorized_keys line from a seed byte. */
function pubKey(seed: number): string {
  const type = Buffer.from("ssh-ed25519");
  const len = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  const key = Buffer.alloc(32, seed);
  return `ssh-ed25519 ${Buffer.concat([len(type.length), type, len(32), key]).toString("base64")} polaris-agent-deploy`;
}

let keySeq = 0;
function nextPair() {
  keySeq++;
  return { privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\nfake${keySeq}\n-----END OPENSSH PRIVATE KEY-----\n`, publicKey: pubKey(keySeq) };
}

const setting = () => h.setting.value as Record<string, any>;

async function expectStatus(p: Promise<unknown>, status: number, msg?: RegExp): Promise<void> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).httpStatus).toBe(status);
  if (msg) expect((err as Error).message).toMatch(msg);
}

function seedCred(id: string, name: string, config: Record<string, unknown>): void {
  h.creds.set(id, { id, name, type: "ssh", config });
}

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
  _invalidateCache();
  h.creds.clear();
  h.seq = 0;
  h.setting.value = undefined;
  keySeq = 0;
  h.keygen.mockReset();
  h.keygen.mockImplementation(() => nextPair());
  h.createCredential.mockReset();
  h.createCredential.mockImplementation(async (input: { name: string; type: string; config: Record<string, unknown> }) => {
    const id = `cred-${++h.seq}`;
    h.creds.set(id, { id, name: input.name, type: input.type, config: { ...input.config } });
    return { id, name: input.name, type: input.type, config: input.config };
  });
  stubbed(prisma.setting.findUnique).mockImplementation(async () => (h.setting.value === undefined ? null : { key: "windowsSshOnboarding", value: h.setting.value }));
  stubbed(prisma.setting.upsert).mockImplementation(async ({ update }: { update: { value: unknown } }) => {
    h.setting.value = JSON.parse(JSON.stringify(update.value));
    return {};
  });
  stubbed(prisma.credential.findMany).mockImplementation(async () => [...h.creds.values()].map((c) => ({ name: c.name })));
  stubbed(prisma.credential.update).mockImplementation(async ({ where, data }: { where: { id: string }; data: { config: Record<string, unknown> } }) => {
    const c = h.creds.get(where.id)!;
    c.config = { ...data.config };
    return c;
  });
  for (const f of [onboard.buildWindowsOnboardingScript, onboard.buildWindowsOnboardingDetectionScript, onboard.buildLinuxOnboardingScript, onboard.buildLinuxOnboardingDetectionScript, offboard.buildWindowsOffboardingScript, offboard.buildLinuxOffboardingScript]) {
    vi.mocked(f).mockClear();
  }
});

// ─── sshPublicKeyFingerprint ──────────────────────────────────────────────────

describe("sshPublicKeyFingerprint", () => {
  it("is SHA256 over the decoded blob, base64 with the padding stripped", () => {
    const k = pubKey(7);
    const blob = Buffer.from(k.split(" ")[1], "base64");
    expect(sshPublicKeyFingerprint(k)).toBe("SHA256:" + createHash("sha256").update(blob).digest("base64").replace(/=+$/, ""));
  });
  it("ignores the comment and surrounding whitespace", () => {
    const k = pubKey(7);
    expect(sshPublicKeyFingerprint(`  ${k.split(" ").slice(0, 2).join(" ")}   other comment `)).toBe(sshPublicKeyFingerprint(k));
  });
  it.each(["", "ssh-ed25519", null as unknown as string, "ssh-ed25519 !!!!"])("is null for %j", (k) => {
    expect(sshPublicKeyFingerprint(k)).toBeNull();
  });
});

// ─── getOnboardingState / the stored config ───────────────────────────────────

describe("getOnboardingState", () => {
  it("a fresh install: no ids, created-account defaults absent (existing mode, unnamed), no key", async () => {
    const s = await getOnboardingState();
    expect(s).toMatchObject({
      credentialIds: { windows: null, linux: null }, credentialNames: { windows: null, linux: null },
      windows: { accountMode: "existing", username: "" }, linux: { accountMode: "existing", username: "" },
      polarisServerIp: "", generatedAt: null, retiredPublicKeys: [], publicKey: null, fingerprint: null,
    });
  });

  it("a created account with no name defaults to polaris-agent", async () => {
    h.setting.value = { windows: { accountMode: "create" }, linux: { accountMode: "create", username: "" } };
    const s = await getOnboardingState();
    expect(s.windows.username).toBe("polaris-agent");
    expect(s.linux.username).toBe("polaris-agent");
  });

  it("folds the pre-Linux flat shape into the windows slot", async () => {
    seedCred("old", "Windows SSH (Polaris-managed)", { username: "svc", publicKey: pubKey(1) });
    h.setting.value = { credentialId: "old", accountMode: "create", username: "svc" };
    const s = await getOnboardingState();
    expect(s.credentialIds).toEqual({ windows: "old", linux: null });
    expect(s.windows).toEqual({ accountMode: "create", username: "svc" });
    expect(s.publicKey).toBe(pubKey(1));
  });

  it("a nested windows slot wins over legacy flat fields; credentialIds.windows over credentialId", async () => {
    seedCred("new", "W", { username: "x", publicKey: pubKey(2) });
    h.setting.value = { credentialId: "old", credentialIds: { windows: "new" }, accountMode: "create", username: "flat", windows: { accountMode: "existing", username: "nested" } };
    const s = await getOnboardingState();
    expect(s.credentialIds.windows).toBe("new");
    expect(s.windows).toEqual({ accountMode: "existing", username: "nested" });
  });

  it("tolerates junk: non-object, non-string fields, a retired list with blanks, capped at 10", async () => {
    h.setting.value = { polarisServerIp: 5, generatedAt: "", retiredPublicKeys: ["", 3, ...Array.from({ length: 12 }, (_, i) => `k${i}`)] };
    const s = await getOnboardingState();
    expect(s.polarisServerIp).toBe("");
    expect(s.generatedAt).toBeNull();
    expect(s.retiredPublicKeys).toEqual(Array.from({ length: 10 }, (_, i) => `k${i}`));
    _invalidateCache();
    h.setting.value = "garbage";
    await expect(getOnboardingState()).resolves.toMatchObject({ publicKey: null });
  });

  it("a credential deleted out from under it reads as not generated", async () => {
    h.setting.value = { credentialIds: { windows: "gone", linux: "gone2" } };
    const s = await getOnboardingState();
    expect(s.credentialIds).toEqual({ windows: null, linux: null });
    expect(s.publicKey).toBeNull();
  });

  it("takes the public key from the Linux row when only it survives, and never the private half", async () => {
    seedCred("lin", MANAGED_CREDENTIAL_NAMES.linux, { username: "u", publicKey: pubKey(3), privateKey: "SECRET" });
    h.setting.value = { credentialIds: { windows: "gone", linux: "lin" } };
    const s = await getOnboardingState();
    expect(s.credentialIds).toEqual({ windows: null, linux: "lin" });
    expect(s.credentialNames).toEqual({ windows: null, linux: MANAGED_CREDENTIAL_NAMES.linux });
    expect(s.publicKey).toBe(pubKey(3));
    expect(s.fingerprint).toBe(sshPublicKeyFingerprint(pubKey(3)));
    expect(JSON.stringify(s)).not.toContain("SECRET");
  });

  it("caches the setting read for its TTL", async () => {
    await getOnboardingState();
    await getOnboardingState();
    expect(prisma.setting.findUnique).toHaveBeenCalledTimes(1);
  });
});

// ─── saveOnboardingConfig ─────────────────────────────────────────────────────

describe("saveOnboardingConfig", () => {
  it("refuses an unknown platform and an unknown mode", async () => {
    await expectStatus(saveOnboardingConfig({ platform: "macos" }, "a"), 400, /Platform must be/);
    await expectStatus(saveOnboardingConfig({ accountMode: "admin" }, "a"), 400, /Account mode must be/);
    expect(prisma.setting.upsert).not.toHaveBeenCalled();
  });

  it("defaults to the windows platform", async () => {
    await saveOnboardingConfig({ accountMode: "create" }, "alice");
    expect(setting().windows).toEqual({ accountMode: "create", username: "polaris-agent" });
    expect(setting().linux).toEqual({ accountMode: "existing", username: "" });
  });

  it("an existing account must be named", async () => {
    await expectStatus(saveOnboardingConfig({ platform: "windows", accountMode: "existing", username: "" }, "a"), 400, /Windows username is required/);
    await expectStatus(saveOnboardingConfig({ platform: "linux", accountMode: "existing" }, "a"), 400, /Linux username is required/);
  });

  it("Windows accepts DOMAIN\\user for an existing account but not a created one", async () => {
    await saveOnboardingConfig({ platform: "windows", accountMode: "existing", username: "CORP\\svc-polaris" }, "a");
    expect(setting().windows.username).toBe("CORP\\svc-polaris");
    await expectStatus(saveOnboardingConfig({ platform: "windows", accountMode: "create", username: "CORP\\svc" }, "a"), 400, /cannot be created locally/);
  });

  it("Linux refuses DOMAIN\\user and an upper-case name", async () => {
    await expectStatus(saveOnboardingConfig({ platform: "linux", accountMode: "existing", username: "CORP\\svc" }, "a"), 400, /no DOMAIN\\user form/);
    await expectStatus(saveOnboardingConfig({ platform: "linux", accountMode: "existing", username: "Admin" }, "a"), 400, /lowercase letter/);
  });

  it("refuses a bad server IP; trims a good one; a blank leaves the firewall alone", async () => {
    await expectStatus(saveOnboardingConfig({ accountMode: "create", polarisServerIp: "not-an-ip" }, "a"), 400);
    await saveOnboardingConfig({ accountMode: "create", polarisServerIp: " 10.1.2.3 " }, "a");
    expect(setting().polarisServerIp).toBe("10.1.2.3");
    await saveOnboardingConfig({ polarisServerIp: "" }, "a");
    expect(setting().polarisServerIp).toBe("");
  });

  it("a platform save keeps the other platform's slot and the shared fields", async () => {
    await saveOnboardingConfig({ platform: "windows", accountMode: "create", polarisServerIp: "10.0.0.0/24" }, "a");
    await saveOnboardingConfig({ platform: "linux", accountMode: "existing", username: "deploy" }, "a");
    expect(setting()).toMatchObject({ windows: { accountMode: "create", username: "polaris-agent" }, linux: { accountMode: "existing", username: "deploy" }, polarisServerIp: "10.0.0.0/24" });
  });

  it("writes windows_ssh_onboarding.updated on a change", async () => {
    await saveOnboardingConfig({ platform: "linux", accountMode: "create", username: "polaris", polarisServerIp: "10.0.0.9" }, "alice");
    expect(eventLog.logEvent).toHaveBeenCalledTimes(1);
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({
      action: "windows_ssh_onboarding.updated", resourceType: "setting", resourceName: "windowsSshOnboarding", actor: "alice",
      message: "Updated linux SSH deployment settings (account create: polaris)",
      details: { platform: "linux", accountMode: "create", username: "polaris", polarisServerIp: "10.0.0.9" },
    });
  });

  it("re-saving the same values writes nothing and logs nothing", async () => {
    await saveOnboardingConfig({ accountMode: "create" }, "a");
    vi.mocked(prisma.setting.upsert).mockClear();
    eventLog.logEvent.mockClear();
    await saveOnboardingConfig({ accountMode: "create", username: "polaris-agent" }, "a");
    expect(prisma.setting.upsert).not.toHaveBeenCalled();
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });

  it("a cleared polarisServerIp records null in the Event", async () => {
    await saveOnboardingConfig({ accountMode: "create", polarisServerIp: "10.0.0.1" }, "a");
    await saveOnboardingConfig({ polarisServerIp: null }, "a");
    expect(eventLog.logEvent.mock.calls[1][0].details?.polarisServerIp).toBeNull();
  });

  it("re-stamps the managed credential's username, keeping the key", async () => {
    await saveOnboardingConfig({ accountMode: "create" }, "a");
    await generateKeypair("a");
    const winId = setting().credentialIds.windows;
    await saveOnboardingConfig({ platform: "windows", accountMode: "existing", username: "CORP\\svc" }, "a");
    const c = h.creds.get(winId)!.config;
    expect(c.username).toBe("CORP\\svc");
    expect(c.privateKey).toMatch(/BEGIN OPENSSH/);
    // the other platform's credential is untouched
    expect(h.creds.get(setting().credentialIds.linux)!.config.username).toBe("polaris-agent");
  });

  it("does not touch a credential that was deleted", async () => {
    h.setting.value = { credentialIds: { windows: "gone" }, windows: { accountMode: "create", username: "polaris-agent" } };
    await saveOnboardingConfig({ username: "other" }, "a");
    expect(prisma.credential.update).not.toHaveBeenCalled();
  });
});

// ─── generateKeypair ──────────────────────────────────────────────────────────

describe("generateKeypair", () => {
  it("a keygen that cannot produce a parseable key is 500 and writes nothing", async () => {
    h.keygen.mockImplementation(() => { throw new SshKeygenError(5, "bad key"); });
    await expectStatus(generateKeypair("a"), 500, /after 5 attempts: bad key/);
    expect(h.createCredential).not.toHaveBeenCalled();
    expect(prisma.setting.upsert).not.toHaveBeenCalled();
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });

  it("any other keygen error is rethrown as is", async () => {
    const boom = new TypeError("unexpected");
    h.keygen.mockImplementation(() => { throw boom; });
    await expect(generateKeypair("a")).rejects.toBe(boom);
  });

  it("asks for a key commented polaris-agent-deploy", async () => {
    await generateKeypair("a");
    expect(h.keygen).toHaveBeenCalledWith("polaris-agent-deploy");
  });

  it("first generate creates BOTH managed credentials with the SAME key, port 22", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-06-01T12:00:00Z"));
      const s = await generateKeypair("alice");
      expect(h.createCredential).toHaveBeenCalledTimes(2);
      const [w, l] = h.createCredential.mock.calls.map((c) => c[0]);
      expect(w).toMatchObject({ name: MANAGED_CREDENTIAL_NAMES.windows, type: "ssh", config: { username: "polaris-agent", port: 22, publicKey: pubKey(1) } });
      expect(l).toMatchObject({ name: MANAGED_CREDENTIAL_NAMES.linux, type: "ssh", config: { username: "polaris-agent", port: 22, publicKey: pubKey(1) } });
      expect(w.config.privateKey).toBe(l.config.privateKey);
      expect(s).toMatchObject({ credentialIds: { windows: "cred-1", linux: "cred-2" }, publicKey: pubKey(1), generatedAt: "2026-06-01T12:00:00.000Z", retiredPublicKeys: [] });
      expect(JSON.stringify(s)).not.toContain("PRIVATE KEY");
    } finally { vi.useRealTimers(); }
  });

  it("writes the saved username, not the placeholder, when one is named", async () => {
    await saveOnboardingConfig({ platform: "linux", accountMode: "existing", username: "deploy" }, "a");
    await generateKeypair("a");
    expect(h.createCredential.mock.calls[1][0].config.username).toBe("deploy");
  });

  it("the first generate's Event is a warning naming both credentials", async () => {
    await generateKeypair("alice");
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({
      action: "credential.ssh_keypair_generated", resourceType: "credential", resourceId: "cred-1", resourceName: "SSH deployment keypair",
      actor: "alice", level: "warning", message: "Generated the SSH deployment keypair (Windows + Linux credentials)",
      details: { rotated: false, fingerprint: sshPublicKeyFingerprint(pubKey(1)), credentialIds: { windows: "cred-1", linux: "cred-2" } },
    });
  });

  it("rotation REPLACES both rows' config in place (a stale password is dropped) and says the fleet must re-run", async () => {
    await generateKeypair("a");
    h.creds.get("cred-1")!.config.password = "stale";
    eventLog.logEvent.mockClear();
    const s = await generateKeypair("bob");
    expect(h.createCredential).toHaveBeenCalledTimes(2);
    expect(prisma.credential.update).toHaveBeenCalledTimes(2);
    expect(h.creds.get("cred-1")!.config).toEqual({ username: "polaris-agent", privateKey: expect.stringContaining("fake2"), publicKey: pubKey(2), port: 22 });
    expect(h.creds.get("cred-2")!.config.publicKey).toBe(pubKey(2));
    expect(s.publicKey).toBe(pubKey(2));
    const ev = eventLog.logEvent.mock.calls[0][0];
    expect(ev.details).toMatchObject({ rotated: true });
    expect(ev.message).toMatch(/^Regenerated the SSH deployment keypair — every endpoint must re-run/);
  });

  it("rule 166: rotation retires the replaced key once (both rows held it), newest first", async () => {
    await generateKeypair("a");
    await generateKeypair("a");
    expect(setting().retiredPublicKeys).toEqual([pubKey(1)]);
    await generateKeypair("a");
    expect(setting().retiredPublicKeys).toEqual([pubKey(2), pubKey(1)]);
  });

  it("rule 166: the rows holding different keys retire both", async () => {
    seedCred("w", "W", { username: "u", publicKey: pubKey(50), privateKey: "p" });
    seedCred("l", "L", { username: "u", publicKey: `  ${pubKey(51)} `, privateKey: "p" });
    h.setting.value = { credentialIds: { windows: "w", linux: "l" } };
    await generateKeypair("a");
    expect(setting().retiredPublicKeys).toEqual([pubKey(50), pubKey(51)]);
  });

  it("rule 166: a re-retired key moves to the front instead of appearing twice; the list caps at 10", async () => {
    seedCred("w", "W", { username: "u", publicKey: pubKey(60), privateKey: "p" });
    const older = Array.from({ length: 10 }, (_, i) => pubKey(70 + i));
    h.setting.value = { credentialIds: { windows: "w" }, retiredPublicKeys: [older[0], pubKey(60), ...older.slice(1)] };
    await generateKeypair("a");
    const r = setting().retiredPublicKeys as string[];
    expect(r).toHaveLength(10);
    expect(r[0]).toBe(pubKey(60));
    expect(r.filter((k) => k === pubKey(60))).toHaveLength(1);
    expect(r).not.toContain(older[9]);
  });

  it("a row with no public key retires nothing", async () => {
    seedCred("w", "W", { username: "u", password: "pw" });
    h.setting.value = { credentialIds: { windows: "w" } };
    await generateKeypair("a");
    expect(setting().retiredPublicKeys).toEqual([]);
  });

  it("a deleted managed row is recreated (only that platform)", async () => {
    await generateKeypair("a");
    h.creds.delete("cred-2");
    await generateKeypair("a");
    expect(h.createCredential).toHaveBeenCalledTimes(3);
    expect(setting().credentialIds).toEqual({ windows: "cred-1", linux: "cred-3" });
  });

  it("suffixes the managed name when it is taken, skipping taken suffixes", async () => {
    seedCred("x1", MANAGED_CREDENTIAL_NAMES.windows, { username: "u", password: "p" });
    seedCred("x2", `${MANAGED_CREDENTIAL_NAMES.windows} 2`, { username: "u", password: "p" });
    await generateKeypair("a");
    expect(h.createCredential.mock.calls[0][0].name).toBe(`${MANAGED_CREDENTIAL_NAMES.windows} 3`);
    expect(h.createCredential.mock.calls[1][0].name).toBe(MANAGED_CREDENTIAL_NAMES.linux);
  });

  it("409 once every suffix through 99 is taken", async () => {
    seedCred("b", MANAGED_CREDENTIAL_NAMES.windows, {});
    for (let i = 2; i < 100; i++) seedCred(`s${i}`, `${MANAGED_CREDENTIAL_NAMES.windows} ${i}`, {});
    await expectStatus(generateKeypair("a"), 409, /Could not allocate a name/);
  });
});

// ─── getOnboardingScript ──────────────────────────────────────────────────────

describe("getOnboardingScript", () => {
  it("refuses before a keypair exists", async () => {
    await expectStatus(getOnboardingScript("windows", "remediation"), 400, /Generate the deployment keypair/);
  });

  it.each([["windows", "Windows"], ["linux", "Linux"]] as const)("refuses an unnamed existing %s account, every kind", async (platform, label) => {
    await generateKeypair("a");
    for (const kind of ["remediation", "detection", "offboarding"] as const) {
      await expectStatus(getOnboardingScript(platform, kind), 400, new RegExp(`Enter the existing ${label} account`));
    }
  });

  describe("once keyed and named", () => {
    beforeEach(async () => {
      await saveOnboardingConfig({ platform: "windows", accountMode: "create", polarisServerIp: "10.20.0.0/16" }, "a");
      await saveOnboardingConfig({ platform: "linux", accountMode: "existing", username: "deploy" }, "a");
      await generateKeypair("a");
      await generateKeypair("a"); // a retired key to carry
    });

    it("windows remediation: .ps1, the server IP for the firewall rule, the retired keys", async () => {
      const r = await getOnboardingScript("windows", "remediation");
      expect(r).toMatchObject({ platform: "windows", kind: "remediation", filename: "polaris-ssh-onboarding.ps1" });
      expect(onboard.buildWindowsOnboardingScript).toHaveBeenCalledWith({ publicKey: pubKey(2), username: "polaris-agent", accountMode: "create", polarisServerIp: "10.20.0.0/16", retiredPublicKeys: [pubKey(1)] });
      expect(r.script).toContain(pubKey(2).split(" ")[1]);
      expect(r.script).toContain("10.20.0.0/16");
    });

    it("windows detection: its own filename and the same facts", async () => {
      const r = await getOnboardingScript("windows", "detection");
      expect(r.filename).toBe("polaris-ssh-onboarding-detect.ps1");
      expect(onboard.buildWindowsOnboardingDetectionScript).toHaveBeenCalledWith(expect.objectContaining({ accountMode: "create", polarisServerIp: "10.20.0.0/16", retiredPublicKeys: [pubKey(1)] }));
    });

    it("linux remediation and detection: .sh, the Linux account; detection takes no mode or IP", async () => {
      const r = await getOnboardingScript("linux", "remediation");
      expect(r.filename).toBe("polaris-ssh-onboarding.sh");
      expect(onboard.buildLinuxOnboardingScript).toHaveBeenCalledWith({ publicKey: pubKey(2), username: "deploy", accountMode: "existing", polarisServerIp: "10.20.0.0/16", retiredPublicKeys: [pubKey(1)] });
      const d = await getOnboardingScript("linux", "detection");
      expect(d.filename).toBe("polaris-ssh-onboarding-detect.sh");
      expect(onboard.buildLinuxOnboardingDetectionScript).toHaveBeenCalledWith({ publicKey: pubKey(2), username: "deploy", retiredPublicKeys: [pubKey(1)] });
    });

    it("offboarding per platform carries the current and the retired keys", async () => {
      const w = await getOnboardingScript("windows", "offboarding");
      expect(w.filename).toBe("polaris-ssh-offboarding.ps1");
      expect(offboard.buildWindowsOffboardingScript).toHaveBeenCalledWith({ publicKey: pubKey(2), retiredPublicKeys: [pubKey(1)], username: "polaris-agent", accountMode: "create", polarisServerIp: "10.20.0.0/16" });
      const l = await getOnboardingScript("linux", "offboarding");
      expect(l.filename).toBe("polaris-ssh-offboarding.sh");
      expect(offboard.buildLinuxOffboardingScript).toHaveBeenCalledWith(expect.objectContaining({ username: "deploy", accountMode: "existing" }));
    });

    it("no server IP is passed as undefined (the scripts leave the firewall alone)", async () => {
      await saveOnboardingConfig({ platform: "windows", polarisServerIp: "" }, "a");
      await getOnboardingScript("windows", "remediation");
      expect(vi.mocked(onboard.buildWindowsOnboardingScript).mock.calls.at(-1)![0].polarisServerIp).toBeUndefined();
    });
  });
});
