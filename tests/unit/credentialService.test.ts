/**
 * tests/unit/credentialService.test.ts — credentialService's own suite (CQ-T010).
 *
 * Complements, and does not repeat:
 *   - credentialUsage.test.ts        — the usage resolver, the monitoring/class/
 *                                      integration delete guard, path-check guard
 *   - httpCredentialValidation.test.ts — the `http` credential and the check
 *                                      definition validator
 *   - sshPassphrase.test.ts          — the SSH passphrase carrier
 *   - rebootOptIn.test.ts / assetBulkMonitorService.test.ts — callers
 *
 * Covered here: secret masking (stripSecrets) and the mask round-trip on
 * update (mergeConfigPreservingSecrets), the SNMP / WinRM / SSH / REST API
 * validators, the allowReboot carrier (rule 115), create / update / get /
 * list, the rule 167 Discovery guard on delete (public named, private only
 * counted), the P2025 race on delete, and assertCredentialAssignments.
 *
 * Every secret value below is an obvious placeholder — never a real-looking key.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/windowsSshOnboardingService.js", () => ({
  getOnboardingState: vi.fn(async () => ({ credentialIds: { windows: null, linux: null } })),
}));

import {
  stripSecrets,
  validateConfig,
  credentialCanReboot,
  credentialAllowsReboot,
  mergeConfigPreservingSecrets,
  listCredentials,
  getCredential,
  createCredential,
  updateCredential,
  deleteCredential,
  getTestAssetTarget,
  assertCredentialAssignments,
  type CredentialRecord,
} from "../../src/services/credentialService.js";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { SECRET_MASK } from "../../src/utils/secretMask.js";

const FAKE = "fake-secret-value";
const T0 = new Date("2026-01-01T00:00:00Z");

function rec(over: Partial<CredentialRecord>): CredentialRecord {
  return { id: "c1", name: "cred", type: "snmp", config: {}, createdBy: null, createdAt: T0, updatedAt: T0, ...over };
}

function noUsage(): void {
  stubbed(prisma.credential.findUnique).mockResolvedValue({ id: "c1" });
  for (const m of ["asset", "monitorClassOverride", "integration", "managedAgent", "firmwareCredentialBinding", "pathCheck", "networkScan"]) {
    stubbed((prisma as any)[m].findMany).mockResolvedValue([]);
  }
}

beforeEach(() => {
  resetDbStub();
});

describe("stripSecrets", () => {
  it("masks every secret field of each type and leaves the rest readable", () => {
    const snmp = stripSecrets(rec({ type: "snmp", config: { version: "v3", username: "u", authKey: FAKE, privKey: FAKE, community: FAKE } }));
    expect(snmp.config).toEqual({ version: "v3", username: "u", authKey: SECRET_MASK, privKey: SECRET_MASK, community: SECRET_MASK });
    const ssh = stripSecrets(rec({ type: "ssh", config: { username: "u", password: FAKE, privateKey: FAKE, passphrase: FAKE, publicKey: "ssh-ed25519 PUBLIC-HALF" } }));
    expect(ssh.config).toMatchObject({ password: SECRET_MASK, privateKey: SECRET_MASK, passphrase: SECRET_MASK });
    // the generated public half is deliberately NOT a secret
    expect(ssh.config.publicKey).toBe("ssh-ed25519 PUBLIC-HALF");
    expect(stripSecrets(rec({ type: "restapi", config: { baseUrl: "https://x", apiToken: FAKE } })).config.apiToken).toBe(SECRET_MASK);
    expect(stripSecrets(rec({ type: "winrm", config: { username: "u", password: FAKE } })).config.password).toBe(SECRET_MASK);
    expect(stripSecrets(rec({ type: "http", config: { authMode: "basic", username: "u", password: FAKE } })).config).toEqual({ authMode: "basic", username: "u", password: SECRET_MASK });
  });

  it("leaves an empty secret empty (nothing to hide) and does not mutate the input", () => {
    const input = rec({ type: "winrm", config: { username: "u", password: "" } });
    const out = stripSecrets(input);
    expect(out.config.password).toBe("");
    const input2 = rec({ type: "winrm", config: { username: "u", password: FAKE } });
    stripSecrets(input2);
    expect(input2.config.password).toBe(FAKE);
  });

  it("tolerates a null config and an unknown type", () => {
    expect(stripSecrets(rec({ config: null as never })).config).toEqual({});
    expect(stripSecrets(rec({ type: "bogus" as never, config: { password: FAKE } })).config.password).toBe(FAKE);
  });
});

describe("mergeConfigPreservingSecrets", () => {
  it("keeps the stored secret when the mask or a blank comes back", () => {
    const existing = { username: "u", password: FAKE, privateKey: "fake-key-body" };
    expect(mergeConfigPreservingSecrets("ssh", existing, { password: SECRET_MASK, privateKey: "  " })).toEqual(existing);
  });

  it("replaces a secret given a new value and lets non-secret fields change", () => {
    const merged = mergeConfigPreservingSecrets("winrm", { username: "u", password: FAKE }, { username: "v", password: "fake-new" });
    expect(merged).toEqual({ username: "v", password: "fake-new" });
  });

  it("treats an absent secret as unchanged (undefined is masked-equivalent)", () => {
    expect(mergeConfigPreservingSecrets("restapi", { baseUrl: "https://a", apiToken: FAKE }, { baseUrl: "https://b" }))
      .toEqual({ baseUrl: "https://b", apiToken: FAKE });
  });
});

describe("validateConfig — SNMP", () => {
  it("accepts v2c with a community and v3 at each security level", () => {
    expect(() => validateConfig("snmp", { version: "v2c", community: FAKE })).not.toThrow();
    expect(() => validateConfig("snmp", { version: "v3", username: "u", securityLevel: "noAuthNoPriv" })).not.toThrow();
    expect(() => validateConfig("snmp", { version: "v3", username: "u", securityLevel: "authNoPriv", authProtocol: "SHA256", authKey: FAKE })).not.toThrow();
    expect(() => validateConfig("snmp", { version: "v3", username: "u", securityLevel: "authPriv", authProtocol: "SHA", authKey: FAKE, privProtocol: "AES256R", privKey: FAKE })).not.toThrow();
  });

  it.each([
    [{ version: "v1", community: FAKE }, /version/],
    [{ version: "v2c" }, /community/],
    [{ version: "v3", securityLevel: "noAuthNoPriv" }, /username/],
    [{ version: "v3", username: "u", securityLevel: "high" }, /securityLevel/],
    [{ version: "v3", username: "u", securityLevel: "authNoPriv", authProtocol: "SHA1", authKey: FAKE }, /authProtocol/],
    [{ version: "v3", username: "u", securityLevel: "authNoPriv", authProtocol: "MD5" }, /authKey/],
    [{ version: "v3", username: "u", securityLevel: "authPriv", authProtocol: "MD5", authKey: FAKE, privProtocol: "3DES", privKey: FAKE }, /privProtocol/],
    [{ version: "v3", username: "u", securityLevel: "authPriv", authProtocol: "MD5", authKey: FAKE, privProtocol: "AES" }, /privKey/],
    [{ version: "v2c", community: FAKE, port: 0 }, /port/],
    [{ version: "v2c", community: FAKE, port: 70000 }, /port/],
    [{ version: "v2c", community: FAKE, port: 16.5 }, /port/],
  ])("refuses %j", (config, msg) => {
    expect(() => validateConfig("snmp", config as Record<string, unknown>)).toThrow(msg);
  });

  it("accepts a null port as unset", () => {
    expect(() => validateConfig("snmp", { version: "v2c", community: FAKE, port: null })).not.toThrow();
  });
});

describe("validateConfig — WinRM / SSH / REST API", () => {
  it("WinRM needs a username and a password, and a sane port", () => {
    expect(() => validateConfig("winrm", { username: "u", password: FAKE, port: 5986 })).not.toThrow();
    expect(() => validateConfig("winrm", { password: FAKE })).toThrow(/username/);
    expect(() => validateConfig("winrm", { username: "u" })).toThrow(/password/);
    expect(() => validateConfig("winrm", { username: "u", password: FAKE, port: "x" })).toThrow(/port/);
  });

  it("SSH needs a username and a password OR a key; verifyHostKey must be boolean", () => {
    expect(() => validateConfig("ssh", { username: "u", privateKey: "fake-key-body" })).not.toThrow();
    expect(() => validateConfig("ssh", { username: "u", password: FAKE, verifyHostKey: true })).not.toThrow();
    expect(() => validateConfig("ssh", { username: "u" })).toThrow(/password or a private key/);
    expect(() => validateConfig("ssh", { password: FAKE })).toThrow(/username/);
    expect(() => validateConfig("ssh", { username: "u", password: FAKE, verifyHostKey: "yes" })).toThrow(/verifyHostKey/);
    expect(() => validateConfig("ssh", { username: "u", password: FAKE, port: 65536 })).toThrow(/port/);
  });

  it("REST API canonicalizes the base URL (trim, trailing slash) at validation", () => {
    const cfg: Record<string, unknown> = { baseUrl: "  https://device.example/api/  ", apiToken: FAKE };
    validateConfig("restapi", cfg);
    expect(cfg.baseUrl).toBe("https://device.example/api");
  });

  it("REST API refuses a non-URL, a non-http scheme, no token, and a non-boolean verifyTls", () => {
    expect(() => validateConfig("restapi", { apiToken: FAKE })).toThrow(/baseUrl/);
    expect(() => validateConfig("restapi", { baseUrl: "device.example", apiToken: FAKE })).toThrow(/valid URL/);
    expect(() => validateConfig("restapi", { baseUrl: "ftp://device.example", apiToken: FAKE })).toThrow(/http:\/\/ or https:\/\//);
    expect(() => validateConfig("restapi", { baseUrl: "https://device.example" })).toThrow(/apiToken/);
    expect(() => validateConfig("restapi", { baseUrl: "https://device.example", apiToken: FAKE, verifyTls: "no" })).toThrow(/verifyTls/);
  });

  it("refuses an unknown type", () => {
    expect(() => validateConfig("telnet" as never, {})).toThrow(/Unknown credential type/);
  });
});

describe("allowReboot (rule 115)", () => {
  it("credentialCanReboot: ssh, restapi and http form login only", () => {
    expect(credentialCanReboot("ssh", {})).toBe(true);
    expect(credentialCanReboot("restapi", null)).toBe(true);
    expect(credentialCanReboot("http", { authMode: "form" })).toBe(true);
    expect(credentialCanReboot("http", { authMode: "basic" })).toBe(false);
    expect(credentialCanReboot("snmp", {})).toBe(false);
    expect(credentialCanReboot("winrm", undefined)).toBe(false);
  });

  it("credentialAllowsReboot needs the flag strictly true on a capable kind", () => {
    expect(credentialAllowsReboot("ssh", { allowReboot: true })).toBe(true);
    expect(credentialAllowsReboot("ssh", { allowReboot: "true" })).toBe(false);
    expect(credentialAllowsReboot("winrm", { allowReboot: true })).toBe(false);
    expect(credentialAllowsReboot("http", { authMode: "bearer", allowReboot: true })).toBe(false);
  });

  it("stores true on a capable kind, drops false / null, refuses a non-boolean", () => {
    const on: Record<string, unknown> = { username: "u", password: FAKE, allowReboot: true };
    validateConfig("ssh", on);
    expect(on.allowReboot).toBe(true);
    const off: Record<string, unknown> = { username: "u", password: FAKE, allowReboot: false };
    validateConfig("ssh", off);
    expect("allowReboot" in off).toBe(false);
    const nul: Record<string, unknown> = { username: "u", password: FAKE, allowReboot: null };
    validateConfig("ssh", nul);
    expect("allowReboot" in nul).toBe(false);
    expect(() => validateConfig("ssh", { username: "u", password: FAKE, allowReboot: "yes" })).toThrow(/boolean/);
  });

  it("refuses true on SNMP / WinRM so the operator does not believe it took", () => {
    expect(() => validateConfig("winrm", { username: "u", password: FAKE, allowReboot: true })).toThrow(/cannot reboot/);
    expect(() => validateConfig("snmp", { version: "v2c", community: FAKE, allowReboot: true })).toThrow(/cannot reboot/);
  });

  it("silently drops the flag from an http credential switched away from form login", () => {
    const cfg: Record<string, unknown> = { authMode: "bearer", apiToken: FAKE, allowReboot: true };
    validateConfig("http", cfg);
    expect("allowReboot" in cfg).toBe(false);
  });
});

describe("list / get", () => {
  it("listCredentials orders by name and masks every row", async () => {
    stubbed(prisma.credential.findMany).mockResolvedValue([rec({ type: "winrm", config: { username: "u", password: FAKE } })]);
    const rows = await listCredentials();
    expect(prisma.credential.findMany).toHaveBeenCalledWith({ orderBy: { name: "asc" } });
    expect(rows[0].config.password).toBe(SECRET_MASK);
  });

  it("getCredential masks unless revealSecrets, and 404s a missing id", async () => {
    stubbed(prisma.credential.findUnique).mockResolvedValue(rec({ type: "winrm", config: { username: "u", password: FAKE } }));
    expect((await getCredential("c1")).config.password).toBe(SECRET_MASK);
    expect((await getCredential("c1", { revealSecrets: true })).config.password).toBe(FAKE);
    stubbed(prisma.credential.findUnique).mockResolvedValue(null);
    await expect(getCredential("nope")).rejects.toMatchObject({ httpStatus: 404 });
  });

  it("getTestAssetTarget selects only the address fields and 404s a missing asset", async () => {
    stubbed(prisma.asset.findUnique).mockResolvedValue({ id: "a1", hostname: "h", ipAddress: "10.0.0.1", ipv6Address: null, dnsName: null });
    await expect(getTestAssetTarget("a1")).resolves.toMatchObject({ ipAddress: "10.0.0.1" });
    expect(stubbed(prisma.asset.findUnique).mock.calls[0][0].select).toEqual({ id: true, hostname: true, ipAddress: true, ipv6Address: true, dnsName: true });
    stubbed(prisma.asset.findUnique).mockResolvedValue(null);
    await expect(getTestAssetTarget("x")).rejects.toMatchObject({ httpStatus: 404 });
  });
});

describe("createCredential", () => {
  it("trims the name, stamps createdBy, stores the validated config, returns it masked", async () => {
    stubbed(prisma.credential.findUnique).mockResolvedValue(null);
    stubbed(prisma.credential.create).mockImplementation(async ({ data }: any) => rec({ ...data, id: "new" }));
    const out = await createCredential({ name: "  Core SNMP  ", type: "snmp", config: { version: "v2c", community: FAKE }, createdBy: "alice" });
    const data = stubbed(prisma.credential.create).mock.calls[0][0].data;
    expect(data).toMatchObject({ name: "Core SNMP", type: "snmp", createdBy: "alice", config: { version: "v2c", community: FAKE } });
    expect(out.config.community).toBe(SECRET_MASK);
  });

  it("stamps a null owner when none is given", async () => {
    stubbed(prisma.credential.findUnique).mockResolvedValue(null);
    stubbed(prisma.credential.create).mockImplementation(async ({ data }: any) => rec(data));
    await createCredential({ name: "x", type: "winrm", config: { username: "u", password: FAKE } });
    expect(stubbed(prisma.credential.create).mock.calls[0][0].data.createdBy).toBeNull();
  });

  it("refuses a blank name, a bad type, a missing config, an invalid config, and a duplicate name", async () => {
    await expect(createCredential({ name: "  ", type: "snmp", config: {} })).rejects.toMatchObject({ httpStatus: 400 });
    await expect(createCredential({ name: "x", type: "telnet" as never, config: {} })).rejects.toThrow(/must be snmp/);
    await expect(createCredential({ name: "x", type: "snmp", config: null as never })).rejects.toThrow(/config is required/);
    await expect(createCredential({ name: "x", type: "snmp", config: { version: "v2c" } })).rejects.toThrow(/community/);
    stubbed(prisma.credential.findUnique).mockResolvedValue(rec({ id: "other", name: "x" }));
    await expect(createCredential({ name: "x", type: "snmp", config: { version: "v2c", community: FAKE } })).rejects.toMatchObject({ httpStatus: 409 });
    expect(prisma.credential.create).not.toHaveBeenCalled();
  });
});

describe("updateCredential", () => {
  const stored = rec({ id: "c1", name: "WinRM", type: "winrm", config: { username: "u", password: FAKE } });

  function seed(): void {
    stubbed(prisma.credential.findUnique).mockImplementation(async ({ where }: any) => (where.id === "c1" ? stored : null));
    stubbed(prisma.credential.update).mockImplementation(async ({ data }: any) => ({ ...stored, ...data }));
  }

  it("404s a missing credential", async () => {
    stubbed(prisma.credential.findUnique).mockResolvedValue(null);
    await expect(updateCredential("zz", { name: "x" })).rejects.toMatchObject({ httpStatus: 404 });
  });

  it("round-trips the mask: the stored password survives an edit that changes only the username", async () => {
    seed();
    await updateCredential("c1", { config: { username: "v", password: SECRET_MASK } });
    expect(stubbed(prisma.credential.update).mock.calls[0][0].data.config).toEqual({ username: "v", password: FAKE });
  });

  it("validates the MERGED config and never writes createdBy", async () => {
    seed();
    await expect(updateCredential("c1", { config: { port: 99999 } })).rejects.toThrow(/port/);
    await updateCredential("c1", { name: " Renamed " });
    const data = stubbed(prisma.credential.update).mock.calls[0][0].data;
    expect(data).toEqual({ name: "Renamed" });
  });

  it("refuses an empty name and a rename onto another credential's name, but allows keeping its own", async () => {
    seed();
    await expect(updateCredential("c1", { name: " " })).rejects.toMatchObject({ httpStatus: 400 });
    stubbed(prisma.credential.findUnique).mockImplementation(async ({ where }: any) =>
      where.id === "c1" ? stored : where.name === "Taken" ? rec({ id: "c2", name: "Taken" }) : where.name === "WinRM" ? stored : null);
    await expect(updateCredential("c1", { name: "Taken" })).rejects.toMatchObject({ httpStatus: 409 });
    await expect(updateCredential("c1", { name: "WinRM" })).resolves.toMatchObject({ name: "WinRM" });
  });
});

describe("deleteCredential — rule 167 Discovery guard and the delete race", () => {
  it("names a public Discovery that tries the credential and refuses", async () => {
    noUsage();
    stubbed(prisma.networkScan.findMany).mockResolvedValue([
      { name: "Branch sweep", visibility: "public", methods: [{ type: "snmp", credentialIds: ["c1"] }] },
      { name: "Unrelated", visibility: "public", methods: [{ type: "snmp", credentialIds: ["c9"] }] },
    ]);
    await expect(deleteCredential("c1")).rejects.toMatchObject({
      httpStatus: 409,
      message: 'Credential is used by Discovery "Branch sweep"; remove it from that Discovery first',
    });
    expect(prisma.credential.delete).not.toHaveBeenCalled();
  });

  it("counts a private Discovery without naming it (its name is its owner's)", async () => {
    noUsage();
    stubbed(prisma.networkScan.findMany).mockResolvedValue([
      { name: "Alice private", visibility: "private", methods: [{ credentialIds: ["c1"] }] },
    ]);
    const err = await deleteCredential("c1").catch((e) => e);
    expect(err.httpStatus).toBe(409);
    expect(err.message).toBe("Credential is used by 1 Discovery; remove it from that Discovery first");
    expect(err.message).not.toMatch(/Alice/);
  });

  it("mixes named and counted, pluralised", async () => {
    noUsage();
    stubbed(prisma.networkScan.findMany).mockResolvedValue([
      { name: "A", visibility: "public", methods: [{ credentialIds: ["c1"] }] },
      { name: "B", visibility: "public", methods: [{ credentialIds: ["x", "c1"] }] },
      { name: "P1", visibility: "private", methods: [{ credentialIds: ["c1"] }] },
      { name: "P2", visibility: "private", methods: [{ credentialIds: ["c1"] }] },
    ]);
    await expect(deleteCredential("c1")).rejects.toThrow('Credential is used by Discoveries "A", "B" and 2 other Discoveries; remove it from those first');
  });

  it("ignores scans whose methods are not an array or carry no credentialIds", async () => {
    noUsage();
    stubbed(prisma.networkScan.findMany).mockResolvedValue([
      { name: "A", visibility: "public", methods: null },
      { name: "B", visibility: "public", methods: [null, { type: "icmp" }, { credentialIds: "c1" }] },
    ]);
    stubbed(prisma.credential.delete).mockResolvedValue({ id: "c1" });
    await expect(deleteCredential("c1")).resolves.toBeUndefined();
  });

  it("says 'and possibly more' when five path checks come back", async () => {
    noUsage();
    stubbed(prisma.pathCheck.findMany).mockResolvedValue(["a", "b", "c", "d", "e"].map((name) => ({ name })));
    await expect(deleteCredential("c1")).rejects.toThrow(/path checks "a", "b", "c", "d", "e" and possibly more/);
  });

  it("turns a concurrent delete (P2025) into a 404 and rethrows anything else", async () => {
    noUsage();
    stubbed(prisma.credential.delete).mockRejectedValueOnce(Object.assign(new Error("gone"), { code: "P2025" }));
    await expect(deleteCredential("c1")).rejects.toMatchObject({ httpStatus: 404 });
    stubbed(prisma.credential.delete).mockRejectedValueOnce(new Error("db down"));
    await expect(deleteCredential("c1")).rejects.toThrow("db down");
  });

  it("404s a credential that does not exist before checking anything else", async () => {
    noUsage();
    stubbed(prisma.credential.findUnique).mockResolvedValue(null);
    await expect(deleteCredential("c1")).rejects.toMatchObject({ httpStatus: 404 });
    expect(prisma.networkScan.findMany).not.toHaveBeenCalled();
  });
});

describe("assertCredentialAssignments", () => {
  const ROWS = [
    { id: "snmp1", name: "SNMP ro", type: "snmp" },
    { id: "ssh1", name: "SSH ops", type: "ssh" },
  ];
  beforeEach(() => {
    stubbed(prisma.credential.findMany).mockImplementation(async ({ where }: any) => ROWS.filter((r) => where.id.in.includes(r.id)));
  });

  it("does nothing (no query) when no id is being set", async () => {
    await assertCredentialAssignments({ monitorCredentialId: null, cpuMemoryCredentialId: undefined }, null);
    expect(prisma.credential.findMany).not.toHaveBeenCalled();
  });

  it("queries once with de-duplicated ids", async () => {
    await assertCredentialAssignments({ monitorCredentialId: "snmp1", cpuMemoryCredentialId: "snmp1", lldpCredentialId: "ssh1" }, null);
    expect(prisma.credential.findMany).toHaveBeenCalledTimes(1);
    expect(stubbed(prisma.credential.findMany).mock.calls[0][0].where.id.in.sort()).toEqual(["snmp1", "ssh1"]);
  });

  it("400s an id naming no credential, naming the field", async () => {
    await expect(assertCredentialAssignments({ temperatureCredentialId: "ghost" }, null))
      .rejects.toMatchObject({ httpStatus: 400, message: "Credential ghost not found (field: temperatureCredentialId)" });
  });

  it("400s a stream credential of the wrong type for the asset's own polling method", async () => {
    await expect(assertCredentialAssignments({ cpuMemoryCredentialId: "ssh1" }, { cpuMemoryPolling: "snmp" }))
      .rejects.toThrow(/"SSH ops" is a ssh credential, but the cpuMemory stream polls over .* and needs a snmp credential \(field: cpuMemoryCredentialId\)/);
  });

  it("judges the method the request is installing, not the stored one", async () => {
    await expect(assertCredentialAssignments({ cpuMemoryCredentialId: "ssh1", cpuMemoryPolling: "ssh" }, { cpuMemoryPolling: "snmp" })).resolves.toBeUndefined();
    await expect(assertCredentialAssignments({ cpuMemoryCredentialId: "snmp1", cpuMemoryPolling: "ssh" }, { cpuMemoryPolling: "snmp" })).rejects.toMatchObject({ httpStatus: 400 });
  });

  it("skips the type check for the asset default, credential-less methods, and a method cleared to inherit", async () => {
    await expect(assertCredentialAssignments({ monitorCredentialId: "ssh1" }, { cpuMemoryPolling: "snmp" })).resolves.toBeUndefined();
    await expect(assertCredentialAssignments({ responseTimeCredentialId: "ssh1" }, { responseTimePolling: "icmp" })).resolves.toBeUndefined();
    await expect(assertCredentialAssignments({ interfacesCredentialId: "ssh1", interfacesPolling: null }, { interfacesPolling: "snmp" })).resolves.toBeUndefined();
    await expect(assertCredentialAssignments({ lldpCredentialId: "ssh1" }, {})).resolves.toBeUndefined();
  });
});
