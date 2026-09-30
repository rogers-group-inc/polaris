/**
 * tests/unit/agentInstallBulkRetry.test.ts
 *
 * The assets-page bulk "Deploy Agent" verb and the ManagedAgent rows it meets.
 *
 * A selection routinely includes hosts whose first install died — asleep,
 * WinRM off, wrong password. Those rows sit at installStatus="failed", and the
 * bulk verb used to skip them ("agent already installed (status=failed)"),
 * leaving the operator to open each asset and press Retry by hand. Now a
 * failed row is retried in place: the same reset the per-asset retry route
 * performs, with THIS batch's credentials and settings, and the row's own
 * platform / arch kept. Every other state stays skipped — those rows either
 * have work running on the host or an agent worth preserving.
 *
 * Everything remote is mocked; the pool is never reached (setImmediate is
 * stubbed out) because the contract under test is the synchronous half: which
 * rows are created, which are reset, which are skipped, and why.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  findMany:      vi.fn(async () => [] as unknown[]),
  create:        vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: "new-" + args.data.assetId, ...args.data })),
  update:        vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => ({ id: args.where.id, ...args.data })),
  getCredential: vi.fn(async (id: string) => {
    if (id === "ssh-cred")   return { id, name: "ssh",   type: "ssh",   config: {} };
    if (id === "winrm-cred") return { id, name: "winrm", type: "winrm", config: {} };
    if (id === "old-cred")     return { id, name: "old",     type: "winrm", config: {} };
    if (id === "old-ssh-cred") return { id, name: "old-ssh", type: "ssh",   config: {} };
    throw new Error("Credential not found");
  }),
  logEvent:      vi.fn(async () => {}),
}));

vi.mock("../../src/db.js", () => ({
  prisma: {
    asset:        { findMany: h.findMany, findUnique: vi.fn(async () => null) },
    managedAgent: { create: h.create, update: h.update, findUnique: vi.fn(async () => null) },
  },
}));
vi.mock("../../src/services/credentialService.js", () => ({ getCredential: h.getCredential }));
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: h.logEvent }));
vi.mock("../../src/services/certInfo.js", () => ({
  getServerCertFingerprint: () => "ab".repeat(32),
  getServerCertHostnames:   () => ["polaris.example.test"],
}));
vi.mock("../../src/services/agentAutoDeployService.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/agentAutoDeployService.js")>();
  return { ...actual, checkAutoDeployPreconditions: async () => ({ ok: true }) };
});
// loadManifest reads AGENT_BIN_DIR/manifest.json straight off disk.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const manifest = JSON.stringify({
    currentVersion: "9.9.9",
    binaries: {
      "linux-amd64":   "polaris-agent-linux-amd64",
      "linux-arm64":   "polaris-agent-linux-arm64",
      "windows-amd64": "polaris-agent-windows-amd64.exe",
    },
  });
  return {
    ...actual,
    readFile: vi.fn(async (p: unknown, ...rest: unknown[]) =>
      String(p).endsWith("manifest.json") ? manifest : (actual.readFile as any)(p, ...rest)),
  };
});

import { bulkInstallAgents } from "../../src/services/agentInstallService.js";

type Row = {
  id: string; hostname: string; dnsName: null; ipAddress: string; os: string; assetType: string;
  managedAgent: null | {
    id: string; installStatus: string; osPlatform: string; arch: string;
    installCredentialId: string | null; installTransport: string | null;
  };
  discoveredByIntegration: null;
};

function asset(id: string, os: string, managedAgent: Row["managedAgent"] = null): Row {
  return {
    id, hostname: id, dnsName: null, ipAddress: "10.0.0." + id.length, os, assetType: "server",
    managedAgent, discoveredByIntegration: null,
  };
}

const failedLinux = (id: string, extra: Partial<NonNullable<Row["managedAgent"]>> = {}) => asset(id, "Ubuntu 24.04", {
  id: "ma-" + id, installStatus: "failed", osPlatform: "linux", arch: "amd64",
  installCredentialId: "ssh-cred", installTransport: "ssh", ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  // Keep the background pool from running: the remote installer is not the
  // subject here, and the runner would otherwise hit the mocked prisma with
  // reads this file does not model.
  vi.spyOn(globalThis, "setImmediate").mockImplementation((() => ({})) as unknown as typeof setImmediate);
});

async function run(rows: Row[], overrides: Record<string, unknown> = {}) {
  h.findMany.mockResolvedValue(rows);
  return bulkInstallAgents({
    assetIds: rows.map((r) => r.id),
    sshCredentialId: "ssh-cred",
    actor: "tester",
    ...overrides,
  });
}

describe("bulkInstallAgents and rows whose install failed", () => {
  it("retries a failed row in place instead of skipping it", async () => {
    const r = await run([failedLinux("web1")]);

    expect(r.skipped).toEqual([]);
    expect(r.kicked).toBe(1);
    expect(r.retried).toBe(1);
    expect(h.create).not.toHaveBeenCalled();
    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.update.mock.calls[0][0]).toMatchObject({
      where: { id: "ma-web1" },
      data:  { installStatus: "pending", installError: null, installedBy: "tester" },
    });
    // The Event is the per-asset retry's, marked as coming from the bulk verb.
    expect(h.logEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: "agent.install_retry", resourceId: "web1", details: expect.objectContaining({ bulk: true }),
    }));
  });

  it("applies the batch's credential, transport, script variant and privilege tier to the retry", async () => {
    const failedWindows = asset("win1", "Windows Server 2022", {
      id: "ma-win1", installStatus: "failed", osPlatform: "windows", arch: "amd64",
      installCredentialId: "old-cred", installTransport: "winrm",
    });
    const r = await run([failedLinux("web1"), failedWindows], {
      sshCredentialId: "ssh-cred", winrmCredentialId: "winrm-cred", privilegeTier: "ptrace",
    });

    expect(r.retried).toBe(2);
    const byRow = new Map(h.update.mock.calls.map((c) => [c[0].where.id, c[0].data]));
    expect(byRow.get("ma-web1")).toMatchObject({ installCredentialId: "ssh-cred", installTransport: "ssh", privilegeTier: "ptrace" });
    // Windows takes the batch's WinRM credential, not the one the failed
    // install was started with, and the Linux-only tier never lands on it.
    expect(byRow.get("ma-win1")).toMatchObject({ installCredentialId: "winrm-cred", installTransport: "winrm", privilegeTier: "unprivileged" });
  });

  it("keeps the row's own platform and arch — the host has not changed", async () => {
    // Discovery now says Windows and the batch is amd64, but the failed row
    // was installed as linux/arm64 — a retry re-runs THAT install.
    const row = failedLinux("pi1", { arch: "arm64" });
    row.os = "Microsoft Windows 11";
    const r = await run([row], { arch: "amd64" });

    expect(r.retried).toBe(1);
    expect(h.update.mock.calls[0][0].data).not.toHaveProperty("osPlatform");
    expect(h.update.mock.calls[0][0].data).not.toHaveProperty("arch");
    expect(h.logEvent).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining("linux/arm64"),
    }));
  });

  it("skips a retry whose platform/arch has no binary built", async () => {
    const r = await run([failedLinux("win-arm", { osPlatform: "windows", arch: "arm64" })], { winrmCredentialId: "winrm-cred" });

    expect(r.retried).toBe(0);
    expect(r.skipped).toEqual([expect.objectContaining({ assetId: "win-arm", reason: "no agent binary built for windows-arm64" })]);
    expect(h.update).not.toHaveBeenCalled();
  });

  it("falls back to the credential the failed install was started with when the batch's do not cover its platform", async () => {
    // A WinRM-only batch cannot reach a Linux host; the per-asset Retry would
    // use the row's own credential, so the bulk verb does too.
    const r = await run([failedLinux("web1", { installCredentialId: "old-ssh-cred" })], {
      sshCredentialId: undefined, winrmCredentialId: "winrm-cred",
    });

    expect(r.retried).toBe(1);
    expect(r.skipped).toEqual([]);
    expect(h.update.mock.calls[0][0].data).toMatchObject({ installCredentialId: "old-ssh-cred", installTransport: "ssh" });
    expect(h.getCredential).toHaveBeenCalledWith("old-ssh-cred");
  });

  it("skips, with the reason, when neither the batch nor the row has a usable credential", async () => {
    const gone    = failedLinux("web1", { installCredentialId: "deleted-cred" });
    const none    = failedLinux("web2", { installCredentialId: null });
    const r = await run([gone, none], { sshCredentialId: undefined, winrmCredentialId: "winrm-cred" });

    expect(r.retried).toBe(0);
    expect(h.update).not.toHaveBeenCalled();
    expect(r.skipped).toHaveLength(2);
    expect(r.skipped[0].reason).toMatch(/last install failed and cannot be retried.*no longer exists/);
    expect(r.skipped[1].reason).toMatch(/last install failed and cannot be retried.*is not on file/);
  });

  it("still skips every other agent state", async () => {
    const states = ["pending", "uploading", "enrolling", "active", "upgrading", "upgrade_failed", "uninstalling", "uninstall_failed", "revoked"];
    const rows = states.map((s) => failedLinux(s, { installStatus: s }));
    const r = await run(rows);

    expect(r.kicked).toBe(0);
    expect(r.retried).toBe(0);
    expect(h.update).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
    expect(r.skipped.map((s) => s.reason)).toEqual(states.map((s) => `agent already installed (status=${s})`));
  });

  it("counts fresh installs and retries together in kicked, retries alone in retried", async () => {
    const r = await run([asset("fresh1", "Debian 12"), failedLinux("web1"), asset("fresh2", "Debian 12")]);

    expect(r.requested).toBe(3);
    expect(r.kicked).toBe(3);
    expect(r.retried).toBe(1);
    expect(h.create).toHaveBeenCalledTimes(2);
    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.logEvent.mock.calls.map((c) => (c[0] as { action: string }).action).sort())
      .toEqual(["agent.install_kickoff", "agent.install_kickoff", "agent.install_retry"]);
  });

  it("a retry whose row vanished under it is a skip, not a batch error", async () => {
    h.update.mockRejectedValueOnce(new Error("Record to update not found."));
    const r = await run([failedLinux("web1"), asset("fresh1", "Debian 12")]);

    expect(r.kicked).toBe(1);
    expect(r.retried).toBe(0);
    expect(r.skipped).toEqual([expect.objectContaining({ assetId: "web1", reason: "Record to update not found." })]);
  });
});
