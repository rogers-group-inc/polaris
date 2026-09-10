/**
 * tests/unit/windowsSshOnboarding.test.ts
 *
 * Coverage for the Windows SSH deployment workflow:
 *   - the generated keypair is one ssh2 can actually connect with
 *   - the private half is written but NEVER returned by a read path
 *   - the public half survives credential masking (it must, or the onboarding
 *     script can't be re-rendered without rotating the key fleet-wide)
 *   - rotation clears the stale password rather than leaving dead config
 *   - config validation matches the script generator's rules
 *
 * Prisma is faked in-memory so credentialService's real validation, naming and
 * masking run for real — mocking credentialService itself would test nothing.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
// Default import, matching the service — ssh2 is CJS and `utils` is not a
// lexer-detected named export under Node's ESM loader.
import ssh2 from "ssh2";
const sshUtils = ssh2.utils;

// ─── In-memory Prisma double ──────────────────────────────────────────────

interface FakeCredential { id: string; name: string; type: string; config: Record<string, unknown>; createdAt: Date; updatedAt: Date }

const db = {
  credentials: [] as FakeCredential[],
  settings: new Map<string, unknown>(),
  nextId: 1,
};

vi.mock("../../src/db.js", () => ({
  prisma: {
    credential: {
      findUnique: vi.fn(async ({ where }: any) => {
        if (where.id) return db.credentials.find((c) => c.id === where.id) ?? null;
        if (where.name) return db.credentials.find((c) => c.name === where.name) ?? null;
        return null;
      }),
      findMany: vi.fn(async ({ where }: any = {}) => {
        const prefix = where?.name?.startsWith;
        return db.credentials.filter((c) => (prefix ? c.name.startsWith(prefix) : true));
      }),
      create: vi.fn(async ({ data }: any) => {
        const row: FakeCredential = {
          id: `cred-${db.nextId++}`,
          name: data.name,
          type: data.type,
          config: data.config,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        db.credentials.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = db.credentials.find((c) => c.id === where.id)!;
        if (data.name !== undefined) row.name = data.name;
        if (data.config !== undefined) row.config = data.config;
        row.updatedAt = new Date();
        return row;
      }),
    },
    setting: {
      findUnique: vi.fn(async ({ where }: any) =>
        db.settings.has(where.key) ? { key: where.key, value: db.settings.get(where.key) } : null,
      ),
      upsert: vi.fn(async ({ where, create, update }: any) => {
        db.settings.set(where.key, db.settings.has(where.key) ? update.value : create.value);
        return { key: where.key, value: db.settings.get(where.key) };
      }),
    },
  },
}));

// logEvent reaches for retention settings and the Event table; neither is
// under test here.
vi.mock("../../src/services/eventLogService.js", () => ({
  logEvent: vi.fn(async () => {}),
}));

import {
  getOnboardingState,
  saveOnboardingConfig,
  generateKeypair,
  getOnboardingScript,
  sshPublicKeyFingerprint,
  MANAGED_CREDENTIAL_NAMES,
  _invalidateCache,
} from "../../src/services/windowsSshOnboardingService.js";
import { getCredential, stripSecrets } from "../../src/services/credentialService.js";
import { logEvent } from "../../src/services/eventLogService.js";

beforeEach(() => {
  db.credentials = [];
  db.settings.clear();
  db.nextId = 1;
  _invalidateCache();
  vi.clearAllMocks();
});

describe("sshPublicKeyFingerprint", () => {
  it("matches the SHA256:base64 form ssh-keygen prints", () => {
    const pub = String(sshUtils.generateKeyPairSync("ed25519", { comment: "x" }).public).trim();
    const fp = sshPublicKeyFingerprint(pub)!;
    expect(fp).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
    // ssh-keygen strips base64 padding; ours must too or the strings won't
    // compare by eye.
    expect(fp.endsWith("=")).toBe(false);
  });

  it("returns null for malformed input rather than throwing", () => {
    expect(sshPublicKeyFingerprint("")).toBeNull();
    expect(sshPublicKeyFingerprint("ssh-ed25519")).toBeNull();
  });
});

describe("getOnboardingState", () => {
  it("reports no keypair on a fresh install, with sane defaults", async () => {
    const s = await getOnboardingState();
    expect(s.publicKey).toBeNull();
    expect(s.fingerprint).toBeNull();
    expect(s.credentialIds).toEqual({ windows: null, linux: null });
    // An existing account has NO default name. Defaulting it to polaris-agent
    // shipped a fleet script whose credential logged in as an account nothing
    // had created.
    expect(s.windows).toEqual({ accountMode: "existing", username: "" });
    expect(s.linux).toEqual({ accountMode: "existing", username: "" });
  });

  it("reads as 'not generated' when the credential was deleted out from under it", async () => {
    await generateKeypair("tester");
    db.credentials = []; // operator deleted it from the Credentials page
    _invalidateCache();
    const s = await getOnboardingState();
    // Must degrade to the Generate path, not 500.
    expect(s.credentialIds).toEqual({ windows: null, linux: null });
    expect(s.publicKey).toBeNull();
  });
});

describe("generateKeypair", () => {
  it("creates the managed credential with a key ssh2 can connect with", async () => {
    const state = await generateKeypair("tester");

    // One managed credential PER PLATFORM, both carrying the same keypair --
    // a Credential holds one username and a Windows DOMAIN\user is
    // meaningless on Linux.
    expect(db.credentials).toHaveLength(2);
    expect(db.credentials.map((c) => c.name)).toEqual([
      MANAGED_CREDENTIAL_NAMES.windows,
      MANAGED_CREDENTIAL_NAMES.linux,
    ]);
    const cred = db.credentials[0];
    expect(cred.type).toBe("ssh");
    // No account named yet, but an ssh credential must carry a username.
    expect(cred.config.username).toBe("polaris-agent");
    // Same private key in both rows.
    expect(db.credentials[1].config.privateKey).toBe(cred.config.privateKey);

    // The stored private key must round-trip through the same parser the
    // connect path uses, or installs would fail at authentication time.
    const parsed = sshUtils.parseKey(String(cred.config.privateKey));
    expect(parsed).not.toBeInstanceOf(Error);
    expect((parsed as any).type).toBe("ssh-ed25519");

    // Public half is the authorized_keys one-liner, and it matches the private.
    expect(state.publicKey).toMatch(/^ssh-ed25519 [A-Za-z0-9+/]+={0,3} polaris-agent-deploy$/);
    expect((parsed as any).getPublicSSH().toString("base64")).toBe(state.publicKey!.split(" ")[1]);

    expect(state.fingerprint).toBe(sshPublicKeyFingerprint(state.publicKey!));
    expect(state.generatedAt).toBeTruthy();
  });

  it("NEVER returns the private key from the state read", async () => {
    const state = await generateKeypair("tester");
    expect(JSON.stringify(state)).not.toContain("PRIVATE KEY");
    expect((state as any).privateKey).toBeUndefined();
  });

  it("stamps a warning-level event, since rotating locks Polaris out fleet-wide", async () => {
    await generateKeypair("tester");
    await generateKeypair("tester"); // rotate

    const calls = (logEvent as any).mock.calls.map((c: any[]) => c[0]);
    const gen = calls.filter((c: any) => c.action === "credential.ssh_keypair_generated");
    expect(gen).toHaveLength(2);
    expect(gen[0].level).toBe("warning");
    expect(gen[0].details.rotated).toBe(false);
    expect(gen[1].details.rotated).toBe(true);
    expect(gen[1].message).toMatch(/re-run its onboarding script/i);
  });

  it("rotates in place — same credential row, new key, password cleared", async () => {
    const first = await generateKeypair("tester");
    const firstKey = db.credentials[0].config.privateKey;
    // Simulate a password left over from a hand-made credential.
    db.credentials[0].config.password = "legacy-password";

    const second = await generateKeypair("tester");

    // Rotation reuses the rows rather than minting more.
    expect(db.credentials).toHaveLength(2);
    expect(second.credentialIds.windows).toBe(first.credentialIds.windows);
    expect(second.credentialIds.linux).toBe(first.credentialIds.linux);
    expect(db.credentials[0].config.privateKey).not.toBe(firstKey);
    expect(second.publicKey).not.toBe(first.publicKey);
    // Rotation REPLACES the config rather than merging it. Merging cannot
    // clear a secret — mergeConfigPreservingSecrets reads an empty string as
    // "keep the stored value" so the edit modal can round-trip a mask. A
    // leftover password is dead config that still reads as a live secret in
    // the UI, and remoteExec silently prefers privateKey anyway.
    expect(db.credentials[0].config.password).toBeUndefined();
  });

  it("suffixes rather than failing when the managed name is already taken", async () => {
    db.credentials.push({
      id: "pre-existing", name: MANAGED_CREDENTIAL_NAMES.windows, type: "ssh",
      config: { username: "someone", password: "pw" },
      createdAt: new Date(), updatedAt: new Date(),
    });
    await generateKeypair("tester");
    expect(db.credentials).toHaveLength(3); // the squatter + one per platform
    expect(db.credentials[1].name).toBe(`${MANAGED_CREDENTIAL_NAMES.windows} 2`);
    expect(db.credentials[2].name).toBe(MANAGED_CREDENTIAL_NAMES.linux);
  });
});

describe("credential masking", () => {
  it("masks the private key but lets the public key through", async () => {
    await generateKeypair("tester");
    const id = db.credentials[0].id;

    const masked = await getCredential(id);
    expect(masked.config.privateKey).not.toContain("PRIVATE KEY");
    // If publicKey were masked, the onboarding script could not be
    // re-rendered without rotating the key across the whole fleet.
    expect(String(masked.config.publicKey)).toMatch(/^ssh-ed25519 /);

    const revealed = await getCredential(id, { revealSecrets: true });
    expect(String(revealed.config.privateKey)).toContain("OPENSSH PRIVATE KEY");
  });

  it("stripSecrets leaves publicKey untouched", () => {
    const out = stripSecrets({
      id: "x", name: "n", type: "ssh",
      config: { username: "u", privateKey: "SECRET", publicKey: "ssh-ed25519 AAAA= c" },
      createdAt: new Date(), updatedAt: new Date(),
    });
    expect(out.config.privateKey).not.toBe("SECRET");
    expect(out.config.publicKey).toBe("ssh-ed25519 AAAA= c");
  });
});

describe("saveOnboardingConfig", () => {
  it("persists valid settings and reports them back", async () => {
    const s = await saveOnboardingConfig(
      { platform: "windows", accountMode: "create", username: "svc-polaris", polarisServerIp: "10.0.0.42" },
      "tester",
    );
    expect(s.windows).toEqual({ accountMode: "create", username: "svc-polaris" });
    expect(s.polarisServerIp).toBe("10.0.0.42");
    // Per-platform: saving Windows must not disturb Linux.
    expect(s.linux.username).toBe("");
  });

  it("requires an existing account to be named, but defaults a created one", async () => {
    await expect(
      saveOnboardingConfig({ platform: "windows", accountMode: "existing", username: "" }, "t"),
    ).rejects.toThrow(/username is required/i);
    await expect(
      saveOnboardingConfig({ platform: "linux", accountMode: "existing", username: "" }, "t"),
    ).rejects.toThrow(/username is required/i);

    const s = await saveOnboardingConfig({ platform: "windows", accountMode: "create", username: "" }, "t");
    expect(s.windows).toEqual({ accountMode: "create", username: "polaris-agent" });
  });

  it("carries a named existing domain account through to the credential", async () => {
    await generateKeypair("tester");
    await saveOnboardingConfig({ platform: "windows", accountMode: "existing", username: "CORP\\svc-polaris" }, "t");
    expect(db.credentials[0].config.username).toBe("CORP\\svc-polaris");
  });

  it("applies the script generator's validation at save time, not download time", async () => {
    await expect(saveOnboardingConfig({ username: "bad;name" }, "t")).rejects.toThrow();
    await expect(saveOnboardingConfig({ polarisServerIp: "nope" }, "t")).rejects.toThrow();
    // Linux is validated with the STRICTER Linux rules, not the Windows ones.
    await expect(
      saveOnboardingConfig({ platform: "linux", username: "CORP\\svc" }, "t"),
    ).rejects.toThrow(/no DOMAIN.user form/i);
    await expect(
      saveOnboardingConfig({ platform: "linux", username: "MixedCase" }, "t"),
    ).rejects.toThrow();
    // A domain account can't be created locally — catch it here rather than on
    // every endpoint in the fleet.
    await expect(
      saveOnboardingConfig({ accountMode: "create", username: "CORP\\svc" }, "t"),
    ).rejects.toThrow(/cannot be created locally/i);
  });

  it("does not log an event when nothing actually changed", async () => {
    await saveOnboardingConfig({ username: "svc-polaris" }, "tester");
    vi.clearAllMocks();
    await saveOnboardingConfig({ username: "svc-polaris" }, "tester");
    expect(logEvent).not.toHaveBeenCalled();
  });
});

describe("getOnboardingScript", () => {
  it("refuses before a keypair exists, pointing at the fix", async () => {
    await expect(getOnboardingScript("windows", "remediation")).rejects.toThrow(/Generate the deployment keypair/i);
  });

  it("refuses the scripts that name an account until an existing one is entered", async () => {
    await generateKeypair("tester");
    await expect(getOnboardingScript("windows", "remediation")).rejects.toThrow(/existing Windows account/i);
    await expect(getOnboardingScript("linux", "remediation")).rejects.toThrow(/existing Linux account/i);
    await expect(getOnboardingScript("linux", "detection")).rejects.toThrow(/existing Linux account/i);
    // Windows detection checks only the key, so it has nothing to refuse over.
    const det = await getOnboardingScript("windows", "detection");
    expect(det.script).toContain((await getOnboardingState()).publicKey!);
  });

  it("returns both variants with distinct filenames once keyed", async () => {
    await generateKeypair("tester");
    await saveOnboardingConfig({ platform: "windows", username: "CORP\\svc-polaris" }, "tester");
    const rem = await getOnboardingScript("windows", "remediation");
    const det = await getOnboardingScript("windows", "detection");

    expect(rem.filename).toBe("polaris-ssh-onboarding.ps1");
    expect(det.filename).toBe("polaris-ssh-onboarding-detect.ps1");
    expect(rem.script).not.toBe(det.script);
    // Both must carry the same key or the pair disagrees about compliance.
    const pub = (await getOnboardingState()).publicKey!;
    expect(rem.script).toContain(pub);
    expect(det.script).toContain(pub);
  });

  it("reflects saved config in the remediation script", async () => {
    await generateKeypair("tester");
    await saveOnboardingConfig(
      { platform: "windows", accountMode: "create", username: "svc-polaris", polarisServerIp: "10.9.9.9" },
      "tester",
    );
    const { script } = await getOnboardingScript("windows", "remediation");
    expect(script).toContain("'svc-polaris'");
    expect(script).toContain("New-LocalUser");
    expect(script).toContain("'10.9.9.9'");
  });
});
