/**
 * tests/unit/agentUpgradeCredential.test.ts
 *
 * `resolveUpgradeCredential` — what an agent upgrade actually connects with.
 *
 * Two independent bugs meet here, and both were invisible in production.
 *
 * 1. STRANDED ROWS. `ManagedAgent.installCredentialId` is written only at
 *    install time and its FK is ON DELETE SET NULL, so a row loses it when the
 *    credential is deleted — or never had it, because the install predates the
 *    column (migration 20260514010000 added it with no backfill). `startUpgrade`
 *    then threw BEFORE touching installStatus, so the row stayed "active" and
 *    out-of-date and every `upgradeAllOutdated` fan-out re-skipped it silently.
 *    A host stranded this way sat on its original binary indefinitely.
 *
 * 2. THE WINRM BACKFILL. Migration 20260609000000 set installTransport='winrm'
 *    on EVERY pre-existing Windows row. The managed deployment credential is
 *    key-only, so honoring the row's transport would hand a passwordless
 *    credential to winrmConnectionFromCred and die on "missing username or
 *    password" — the fallback would have fixed nothing on exactly the rows that
 *    needed it. Hence: transport follows the credential's TYPE. For a healthy
 *    row the two always agree (the install routes refuse a credential whose type
 *    doesn't match the transport), so this is a no-op there.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  getCredential: vi.fn(),
  getOnboardingState: vi.fn(),
}));

vi.mock("../../src/services/credentialService.js", () => ({
  getCredential: h.getCredential,
}));

vi.mock("../../src/services/windowsSshOnboardingService.js", () => ({
  getOnboardingState: h.getOnboardingState,
}));

const { resolveUpgradeCredential } = await import("../../src/services/agentInstallService.js");

/** The shape resolveUpgradeCredential reads off a credential. */
function cred(id: string, name: string, type: "ssh" | "winrm") {
  return { id, name, type, config: {} };
}

/** No keypair generated — the SSH Deployment card was never used. */
const NO_KEYPAIR = { credentialIds: { windows: null, linux: null } };
/** A generated keypair, one managed credential per platform. */
const KEYPAIR = { credentialIds: { windows: "managed-win", linux: "managed-lin" } };

const MANAGED = {
  "managed-win": cred("managed-win", "Windows SSH (Polaris-managed)", "ssh" as const),
  "managed-lin": cred("managed-lin", "Linux SSH (Polaris-managed)", "ssh" as const),
};

beforeEach(() => {
  h.getCredential.mockReset();
  h.getOnboardingState.mockReset();
  h.getOnboardingState.mockResolvedValue(NO_KEYPAIR);
});

/** Resolve these ids, reject everything else the way credentialService does. */
function credentialsExist(map: Record<string, ReturnType<typeof cred>>) {
  h.getCredential.mockImplementation(async (id: string) => {
    const found = map[id];
    if (!found) throw new Error(`Credential ${id} not found`);
    return found;
  });
}

describe("resolveUpgradeCredential — healthy rows", () => {
  it("uses the row's own credential and does not mark it adopted", async () => {
    credentialsExist({ "cred-1": cred("cred-1", "Prod WinRM", "winrm") });

    const r = await resolveUpgradeCredential(
      { installCredentialId: "cred-1", installTransport: "winrm", osPlatform: "windows" },
    );

    expect(r).toMatchObject({ credentialId: "cred-1", transport: "winrm", adopted: false });
    // No reason to consult the deployment card when the row can answer.
    expect(h.getOnboardingState).not.toHaveBeenCalled();
  });

  it("takes the transport from the credential's type, not the row's stale column", async () => {
    // The 20260609000000 backfill wrote winrm onto every existing Windows row,
    // including ones later reinstalled over SSH. The credential is the truth.
    credentialsExist({ "cred-ssh": cred("cred-ssh", "Windows SSH", "ssh") });

    const r = await resolveUpgradeCredential(
      { installCredentialId: "cred-ssh", installTransport: "winrm", osPlatform: "windows" },
    );

    expect(r.transport).toBe("ssh");
  });

  it("resolves linux over SSH", async () => {
    credentialsExist({ "cred-2": cred("cred-2", "Fleet SSH", "ssh") });

    const r = await resolveUpgradeCredential(
      { installCredentialId: "cred-2", installTransport: "ssh", osPlatform: "linux" },
    );

    expect(r).toMatchObject({ credentialId: "cred-2", transport: "ssh", adopted: false });
  });
});

describe("resolveUpgradeCredential — stranded rows", () => {
  beforeEach(() => {
    h.getOnboardingState.mockResolvedValue(KEYPAIR);
    credentialsExist(MANAGED);
  });

  it("falls back to the managed Windows credential over SSH, not the row's winrm", async () => {
    // The exact production shape: a pre-2026-05-14 Windows install, so no
    // credential on file, and the transport backfilled to winrm.
    const r = await resolveUpgradeCredential(
      { installCredentialId: null, installTransport: "winrm", osPlatform: "windows" },
    );

    expect(r).toMatchObject({
      credentialId:   "managed-win",
      credentialName: "Windows SSH (Polaris-managed)",
      transport:      "ssh",
      adopted:        true,
    });
  });

  it("falls back to the managed Linux credential", async () => {
    const r = await resolveUpgradeCredential(
      { installCredentialId: null, installTransport: "ssh", osPlatform: "linux" },
    );

    expect(r).toMatchObject({ credentialId: "managed-lin", adopted: true });
  });

  it("maps darwin onto the Linux credential — both POSIX platforms share the key", async () => {
    const r = await resolveUpgradeCredential(
      { installCredentialId: null, installTransport: "ssh", osPlatform: "darwin" },
    );

    expect(r).toMatchObject({ credentialId: "managed-lin", transport: "ssh", adopted: true });
  });

  it("treats an id that no longer resolves the same as none", async () => {
    // SetNull covers deletion, but a credential can also become unreadable
    // (secrets that won't decrypt). Fall back rather than refuse.
    const r = await resolveUpgradeCredential(
      { installCredentialId: "deleted-cred", installTransport: "ssh", osPlatform: "linux" },
    );

    expect(r).toMatchObject({ credentialId: "managed-lin", adopted: true });
  });
});

describe("resolveUpgradeCredential — refusals", () => {
  it("refuses when the row is stranded and no keypair has been generated", async () => {
    h.getOnboardingState.mockResolvedValue(NO_KEYPAIR);
    credentialsExist({});

    await expect(resolveUpgradeCredential(
      { installCredentialId: null, installTransport: "winrm", osPlatform: "windows" },
    )).rejects.toThrow(/SSH Deployment/);
  });

  it("refuses an explicit credentialId that doesn't exist instead of silently falling back", async () => {
    // An operator who names a credential gets told it's wrong. Quietly
    // connecting with a different one would be a worse answer than an error.
    h.getOnboardingState.mockResolvedValue(KEYPAIR);
    credentialsExist(MANAGED);

    await expect(resolveUpgradeCredential(
      { installCredentialId: null, installTransport: "ssh", osPlatform: "linux" },
      "typo-id",
    )).rejects.toThrow(/typo-id not found/);
  });

  it("refuses a WinRM credential on a non-Windows agent", async () => {
    credentialsExist({ "cred-w": cred("cred-w", "Some WinRM", "winrm") });

    await expect(resolveUpgradeCredential(
      { installCredentialId: "cred-w", installTransport: "winrm", osPlatform: "linux" },
    )).rejects.toThrow(/only valid for Windows/);
  });

  it("refuses when the deployment card itself is unreadable", async () => {
    h.getOnboardingState.mockRejectedValue(new Error("settings store down"));
    credentialsExist({});

    await expect(resolveUpgradeCredential(
      { installCredentialId: null, installTransport: "ssh", osPlatform: "linux" },
    )).rejects.toThrow(/No install credential on file/);
  });
});

describe("resolveUpgradeCredential — explicit override", () => {
  it("wins over the row's credential and is never marked adopted", async () => {
    // adopted=false matters: an operator-supplied credential must not be
    // written back onto the row as if Polaris had chosen it.
    credentialsExist({
      "row-cred":      cred("row-cred", "Old", "winrm"),
      "operator-cred": cred("operator-cred", "New", "ssh"),
    });

    const r = await resolveUpgradeCredential(
      { installCredentialId: "row-cred", installTransport: "winrm", osPlatform: "windows" },
      "operator-cred",
    );

    expect(r).toMatchObject({ credentialId: "operator-cred", transport: "ssh", adopted: false });
  });
});
