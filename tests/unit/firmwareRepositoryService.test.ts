/**
 * tests/unit/firmwareRepositoryService.test.ts — firmwareRepositoryService's own
 * suite (CQ-T010).
 *
 * Complements, and does not repeat:
 *   - firmwareImageRotation.test.ts   — rule 87 upload rotation, make-primary,
 *                                       delete, purge, upload containment (real fs)
 *   - firmwareFileSweep.test.ts       — rule 158(b) sweep
 *   - firmwareCredentialTokens.test.ts — the FortiGate token half of
 *                                       resolveFirmwareCredential
 *   - firmwareVsPrimary.test.ts       — primaryImageForAsset / firmwareVsPrimary
 *   - credentialUsage.test.ts         — firmwareBindingCredentialIds through the
 *                                       Stored Credentials usage count
 *
 * Covered here: the binding verbs (upsertBinding scope + kind validation, the
 * null-credential delete, update vs create, Events; deleteBinding;
 * listBindings' stale flag), getFirmwareTree (fold, effective-binding tiers with
 * the token-on-a-switch skip, orphaned model nodes, the platform warning, the
 * type-label fallback), the FORM-LOGIN half of resolveFirmwareCredential
 * (tier order, dead / modeless / passwordless credentials fall through,
 * revealSecrets false hands back no secret), firmwareBindingCredentialIds tier
 * order, findUpgradeCandidates' reasons, listAssetsForNode's filter,
 * listRecentRuns' clamp, resolveImagePath containment, getImageDownload /
 * getImage 404s, and registerUploadedImage's refusals before any byte is read.
 *
 * Secrets below are placeholders. No file is written; `rm` is a spy.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolve, sep } from "node:path";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) => import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
const h = vi.hoisted(() => ({
  credentials: new Map<string, { type: string; config: Record<string, unknown> }>(),
  rm: vi.fn(async (..._a: unknown[]) => undefined),
  listAssetTypes: vi.fn(async (): Promise<Array<{ name: string; label: string }>> => []),
}));
vi.mock("../../src/services/credentialService.js", () => ({
  getCredential: vi.fn(async (id: string) => {
    const c = h.credentials.get(id);
    if (!c) throw Object.assign(new Error("Credential not found"), { httpStatus: 404 });
    return { id, name: id, ...c };
  }),
}));
vi.mock("../../src/services/assetTypeService.js", () => ({ listAssetTypes: h.listAssetTypes }));
vi.mock("node:fs/promises", async (orig) => ({ ...(await orig<Record<string, unknown>>()), rm: h.rm }));

import {
  upsertBinding,
  deleteBinding,
  listBindings,
  getFirmwareTree,
  resolveFirmwareCredential,
  firmwareBindingCredentialIds,
  findUpgradeCandidates,
  listAssetsForNode,
  listRecentRuns,
  resolveImagePath,
  getImage,
  getImageDownload,
  registerUploadedImage,
} from "../../src/services/firmwareRepositoryService.js";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
import { FIRMWARE_DIR, FIRMWARE_INCOMING_DIR } from "../../src/utils/paths.js";

const T0 = new Date("2026-05-01T00:00:00Z");
const binding = (over: Record<string, unknown>) => ({
  id: "b-" + String(over.model ?? over.assetType ?? "mfr"), manufacturer: "Fortinet", assetType: null, model: null,
  source: "credential", credentialId: null, credential: null, ...over,
});
const loginRef = (id: string) => ({ id, name: id + "-name", type: "http" });
function image(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "img-1", manufacturer: "Fortinet", assetType: "switch", model: "FortiSwitch S108FF", platform: "S108FF",
    versionMajor: 7, versionMinor: 6, versionPatch: 8, build: 1164, versionLabel: "7.6.8 build1164", parsedFrom: "header",
    role: "primary", filename: "FSW_108F.out", sizeBytes: 1000, sha256: "ab".repeat(32), storagePath: "img-1.out",
    notes: null, uploadedBy: "alice", uploadedAt: T0, ...over,
  };
}

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
  h.rm.mockClear();
  h.listAssetTypes.mockReset();
  h.listAssetTypes.mockResolvedValue([{ name: "switch", label: "Switches" }]);
  h.credentials = new Map([
    ["login-a", { type: "http", config: { authMode: "form", username: "admin", password: "fake-pass-a" } }],
    ["login-b", { type: "http", config: { authMode: "form", username: "ops", password: "fake-pass-b" } }],
    ["modeless", { type: "http", config: { authMode: "basic", username: "x", password: "fake" } }],
    ["no-pass", { type: "http", config: { authMode: "form", username: "x", password: "" } }],
  ]);
});

describe("upsertBinding — scope and kind", () => {
  it("refuses a blank manufacturer, an unknown type, and a model without its type", async () => {
    await expect(upsertBinding({ manufacturer: "  ", credentialId: "x" })).rejects.toThrow(/manufacturer is required/);
    await expect(upsertBinding({ manufacturer: "Fortinet", assetType: "server", credentialId: "x" })).rejects.toThrow(/assetType must be/);
    await expect(upsertBinding({ manufacturer: "Fortinet", model: "S108FF", credentialId: "x" })).rejects.toThrow(/needs its device type/);
  });

  it("binds the integration token only on a Firewall node", async () => {
    stubbed(prisma.firmwareCredentialBinding.findFirst).mockResolvedValue(null);
    await expect(upsertBinding({ manufacturer: "Fortinet", assetType: "switch", credentialId: null, source: "integration-token" })).rejects.toThrow(/only sign in to FortiGates/);
    stubbed(prisma.firmwareCredentialBinding.create).mockImplementation(async ({ data }: any) => ({ id: "b1", ...data, credential: null }));
    const ref = await upsertBinding({ manufacturer: "Fortinet", assetType: "firewall", credentialId: "ignored", source: "integration-token", actor: "alice" });
    expect(stubbed(prisma.firmwareCredentialBinding.create).mock.calls[0][0].data).toMatchObject({ manufacturer: "Fortinet", assetType: "firewall", model: null, source: "integration-token", credentialId: null, createdBy: "alice" });
    expect(ref).toEqual({ id: "b1", source: "integration-token", credentialId: null, credentialName: "Integration API token", stale: false });
  });

  it("accepts a form login anywhere, a REST token on a firewall only, and nothing else", async () => {
    stubbed(prisma.firmwareCredentialBinding.findFirst).mockResolvedValue(null);
    stubbed(prisma.firmwareCredentialBinding.create).mockImplementation(async ({ data }: any) => ({ id: "b1", ...data, credential: { id: data.credentialId, name: "N" } }));
    const creds: Record<string, unknown> = {
      login: { id: "login", name: "Switch admin", type: "http", config: { authMode: "form" } },
      token: { id: "token", name: "Gate token", type: "restapi", config: {} },
      basic: { id: "basic", name: "Basic", type: "http", config: { authMode: "basic" } },
      ssh: { id: "ssh", name: "SSH", type: "ssh", config: {} },
    };
    stubbed(prisma.credential.findUnique).mockImplementation(async ({ where }: any) => creds[where.id] ?? null);

    await expect(upsertBinding({ manufacturer: "Fortinet", assetType: "switch", model: "S108FF", credentialId: "login" })).resolves.toMatchObject({ credentialId: "login" });
    await expect(upsertBinding({ manufacturer: "Fortinet", credentialId: "login" })).resolves.toMatchObject({ credentialId: "login" });
    await expect(upsertBinding({ manufacturer: "Fortinet", assetType: "firewall", credentialId: "token" })).resolves.toMatchObject({ credentialId: "token" });
    await expect(upsertBinding({ manufacturer: "Fortinet", assetType: "access_point", credentialId: "token" })).rejects.toThrow(/REST API token credential can only sign in to FortiGates/);
    await expect(upsertBinding({ manufacturer: "Fortinet", assetType: "switch", credentialId: "basic" })).rejects.toThrow(/needs an HTTP credential in "Device admin login \(form\)" mode$/);
    await expect(upsertBinding({ manufacturer: "Fortinet", assetType: "firewall", credentialId: "ssh" })).rejects.toThrow(/or a REST API credential/);
    await expect(upsertBinding({ manufacturer: "Fortinet", assetType: "switch", credentialId: "gone" })).rejects.toThrow(/no longer exists/);
    const msgs = eventLog.logEvent.mock.calls.map((c) => c[0].message);
    expect(msgs[0]).toBe('Device login "Switch admin" bound at Fortinet › switch › S108FF');
    expect(msgs[2]).toBe('REST API token "Gate token" bound at Fortinet › firewall');
  });

  it("updates an existing binding at the same scope instead of creating a second", async () => {
    stubbed(prisma.firmwareCredentialBinding.findFirst).mockResolvedValue({ id: "b-old" });
    stubbed(prisma.credential.findUnique).mockResolvedValue({ id: "login", name: "L", type: "http", config: { authMode: "form" } });
    stubbed(prisma.firmwareCredentialBinding.update).mockResolvedValue({ id: "b-old", source: "credential", credentialId: "login", credential: { id: "login", name: "L" } });
    await upsertBinding({ manufacturer: "Fortinet", assetType: "switch", credentialId: "login" });
    expect(stubbed(prisma.firmwareCredentialBinding.update).mock.calls[0][0]).toMatchObject({ where: { id: "b-old" }, data: { source: "credential", credentialId: "login" } });
    expect(prisma.firmwareCredentialBinding.create).not.toHaveBeenCalled();
  });

  it("credentialId null removes the binding at that scope (Event), and is a quiet no-op when none exists", async () => {
    stubbed(prisma.firmwareCredentialBinding.findFirst).mockResolvedValue({ id: "b-old" });
    await expect(upsertBinding({ manufacturer: "Fortinet", assetType: "switch", credentialId: null, actor: "bob" })).resolves.toBeNull();
    expect(prisma.firmwareCredentialBinding.delete).toHaveBeenCalledWith({ where: { id: "b-old" } });
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({ action: "firmware.binding_deleted", actor: "bob", resourceName: "Fortinet › switch" });
    stubbed(prisma.firmwareCredentialBinding.findFirst).mockResolvedValue(null);
    resetEventLogStub();
    await expect(upsertBinding({ manufacturer: "Fortinet", credentialId: null })).resolves.toBeNull();
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });
});

describe("deleteBinding / listBindings", () => {
  it("deleteBinding 404s a missing id and logs the removed scope", async () => {
    stubbed(prisma.firmwareCredentialBinding.findUnique).mockResolvedValue(null);
    await expect(deleteBinding("x")).rejects.toMatchObject({ httpStatus: 404 });
    stubbed(prisma.firmwareCredentialBinding.findUnique).mockResolvedValue({ id: "b", manufacturer: "Fortinet", assetType: "firewall", model: "FortiGate 60F" });
    await deleteBinding("b", "carol");
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({ resourceName: "Fortinet › firewall › FortiGate 60F", actor: "carol" });
  });

  it("listBindings marks a credential binding whose credential was deleted as stale", async () => {
    stubbed(prisma.firmwareCredentialBinding.findMany).mockResolvedValue([
      binding({ id: "b1", credentialId: null }),
      binding({ id: "b2", assetType: "switch", credentialId: "login-a", credential: loginRef("login-a") }),
      binding({ id: "b3", assetType: "firewall", source: "integration-token" }),
    ]);
    const rows = await listBindings();
    expect(rows.map((r) => [r.id, r.stale, r.credentialName])).toEqual([
      ["b1", true, null], ["b2", false, "login-a-name"], ["b3", false, "Integration API token"],
    ]);
  });
});

describe("getFirmwareTree", () => {
  function seed(): void {
    stubbed(prisma.asset.groupBy).mockResolvedValue([
      { manufacturer: "Fortinet", assetType: "switch", model: "FortiSwitch S108FF", _count: { _all: 3 } },
      { manufacturer: "Fortinet", assetType: "switch", model: null, _count: { _all: 1 } },
      { manufacturer: "Fortinet", assetType: "firewall", model: "FortiGate 60F", _count: { _all: 2 } },
      { manufacturer: null, assetType: "switch", model: "x", _count: { _all: 9 } },
    ]);
    stubbed(prisma.firmwareImage.findMany).mockResolvedValue([
      image({ id: "i-back", role: "backup", uploadedAt: new Date("2026-04-01T00:00:00Z") }),
      image({ id: "i-prim" }),
      image({ id: "i-orph", model: "FortiSwitch 424E", platform: "S424EF" }),
      image({ id: "i-noplat", model: "FortiSwitch S108FF", platform: null, role: "backup", uploadedAt: new Date("2026-03-01T00:00:00Z") }),
    ]);
    stubbed(prisma.asset.findMany).mockResolvedValue([
      { manufacturer: "Fortinet", assetType: "switch", model: "FortiSwitch S108FF", serialNumber: "S108EPTF00000001" },
    ]);
    stubbed(prisma.firmwareCredentialBinding.findMany).mockResolvedValue([
      binding({ id: "b-mfr-token", source: "integration-token" }), // manufacturer-wide token: never a switch
      binding({ id: "b-sw", assetType: "switch", credentialId: "login-a", credential: loginRef("login-a") }),
      binding({ id: "b-model-dead", assetType: "switch", model: "FortiSwitch S108FF", credentialId: null }),
    ]);
  }

  it("folds assets and images into manufacturer › type › model, counting and sorting", async () => {
    seed();
    const tree = await getFirmwareTree();
    expect(tree.manufacturers.map((m) => [m.name, m.assetCount])).toEqual([["Fortinet", 6]]);
    const types = tree.manufacturers[0].assetTypes;
    expect(types.map((t) => [t.assetType, t.label, t.engine, t.assetCount])).toEqual([
      ["switch", "Switches", "fortiswitch-https", 4], ["firewall", "firewall", "fortigate-https", 2],
    ]);
    const models = types[0].models;
    expect(models.map((m) => [m.model, m.assetCount, m.orphaned])).toEqual([
      ["", 1, false], ["FortiSwitch 424E", 0, true], ["FortiSwitch S108FF", 3, false],
    ]);
    // primary first, then backups newest-first
    expect(models[2].images.map((i) => i.id)).toEqual(["i-prim", "i-back", "i-noplat"]);
  });

  it("warns about an image whose platform no asset under the model carries, and one with no platform", async () => {
    seed();
    const s108 = (await getFirmwareTree()).manufacturers[0].assetTypes[0].models[2];
    expect(s108.images[0].warnings).toEqual(["No asset under this model carries serial prefix S108FF."]);
    expect(s108.images[2].warnings[0]).toMatch(/no platform is known/);
  });

  it("effective binding: a dead model binding falls through to the type; a manufacturer token never reaches a switch but does a firewall", async () => {
    seed();
    const [sw, fw] = (await getFirmwareTree()).manufacturers[0].assetTypes;
    const s108 = sw.models[2];
    expect(s108.binding).toMatchObject({ id: "b-model-dead", stale: true });
    expect(s108.effectiveBinding).toEqual({ source: "credential", credentialId: "login-a", credentialName: "login-a-name", scope: "assetType" });
    expect(fw.effectiveBinding).toEqual({ source: "integration-token", credentialId: null, credentialName: "Integration API token", scope: "manufacturer" });
    expect((await getFirmwareTree()).manufacturers[0].effectiveBinding).toBeNull();
  });

  it("falls back to built-in labels when the asset-type catalogue cannot be read", async () => {
    seed();
    h.listAssetTypes.mockRejectedValue(new Error("db down"));
    const types = (await getFirmwareTree()).manufacturers[0].assetTypes;
    expect(types.map((t) => t.label)).toEqual(["Switch", "Firewall"]);
  });
});

describe("resolveFirmwareCredential — form logins", () => {
  const sw = { manufacturer: "Fortinet", assetType: "switch", model: "FortiSwitch S108FF" };

  it("returns null for an asset with no manufacturer, without a query", async () => {
    await expect(resolveFirmwareCredential({ ...sw, manufacturer: null }, { revealSecrets: true })).resolves.toBeNull();
    expect(prisma.firmwareCredentialBinding.findMany).not.toHaveBeenCalled();
  });

  it("model beats type beats manufacturer, and reveals the login only when asked", async () => {
    stubbed(prisma.firmwareCredentialBinding.findMany).mockResolvedValue([
      binding({ id: "m", credentialId: "login-a", credential: loginRef("login-a") }),
      binding({ id: "t", assetType: "switch", credentialId: "login-b", credential: loginRef("login-b") }),
      binding({ id: "md", assetType: "switch", model: "FortiSwitch S108FF", credentialId: "login-b", credential: loginRef("login-b") }),
    ]);
    await expect(resolveFirmwareCredential(sw, { revealSecrets: true })).resolves.toEqual({
      source: "credential", credentialId: "login-b", credentialName: "login-b-name", scope: "model", username: "ops", password: "fake-pass-b",
    });
    const masked = await resolveFirmwareCredential(sw, { revealSecrets: false });
    expect(masked).toEqual({ source: "credential", credentialId: "login-b", credentialName: "login-b-name", scope: "model" });
    expect(masked).not.toHaveProperty("password");
  });

  it("a credential that lost its form mode or its password falls through to the next tier", async () => {
    stubbed(prisma.firmwareCredentialBinding.findMany).mockResolvedValue([
      binding({ id: "md", assetType: "switch", model: "FortiSwitch S108FF", credentialId: "modeless", credential: loginRef("modeless") }),
      binding({ id: "t", assetType: "switch", credentialId: "no-pass", credential: loginRef("no-pass") }),
      binding({ id: "m", credentialId: "login-a", credential: loginRef("login-a") }),
    ]);
    await expect(resolveFirmwareCredential(sw, { revealSecrets: true })).resolves.toMatchObject({ scope: "manufacturer", username: "admin" });
  });

  it("queries the asset's normalised manufacturer at its three scopes", async () => {
    stubbed(prisma.firmwareCredentialBinding.findMany).mockResolvedValue([]);
    await expect(resolveFirmwareCredential({ ...sw, model: null }, { revealSecrets: false })).resolves.toBeNull();
    expect(stubbed(prisma.firmwareCredentialBinding.findMany).mock.calls[0][0].where.OR).toEqual([
      { assetType: "switch", model: "" }, { assetType: "switch", model: null }, { assetType: null },
    ]);
  });
});

describe("firmwareBindingCredentialIds", () => {
  it("maps each eligible asset to its winning live credential binding; tokens and non-firmware types map to nothing", async () => {
    stubbed(prisma.firmwareCredentialBinding.findMany).mockResolvedValue([
      binding({ id: "m", credentialId: "login-a", credential: loginRef("login-a") }),
      binding({ id: "md", assetType: "switch", model: "S108", credentialId: "login-b", credential: loginRef("login-b") }),
      binding({ id: "fw", assetType: "firewall", source: "integration-token" }),
    ]);
    const out = await firmwareBindingCredentialIds([
      { id: "a1", manufacturer: "Fortinet", assetType: "switch", model: "S108" },
      { id: "a2", manufacturer: "Fortinet", assetType: "switch", model: "Other" },
      { id: "a3", manufacturer: "Fortinet", assetType: "firewall", model: "60F" },
      { id: "a4", manufacturer: "Fortinet", assetType: "server", model: "x" },
      { id: "a5", manufacturer: null, assetType: "switch", model: "S108" },
    ]);
    expect(Object.fromEntries(out)).toEqual({ a1: "login-b", a2: "login-a" });
  });

  it("skips the bindings query when no asset is eligible", async () => {
    const out = await firmwareBindingCredentialIds([{ id: "a", manufacturer: "Dell", assetType: "server", model: null }]);
    expect(out.size).toBe(0);
    expect(prisma.firmwareCredentialBinding.findMany).not.toHaveBeenCalled();
  });
});

describe("findUpgradeCandidates", () => {
  const sw = { manufacturer: "Fortinet", assetType: "switch", model: "FortiSwitch S108FF", serialNumber: "S108FFTF23000001", osVersion: "7.4.3 build0542" };

  it("names why there is nothing to offer, querying nothing when no engine applies", async () => {
    await expect(findUpgradeCandidates({ ...sw, manufacturer: "Cisco" })).resolves.toMatchObject({ reason: "no-engine", engine: null });
    await expect(findUpgradeCandidates({ ...sw, serialNumber: null })).resolves.toMatchObject({ reason: "no-engine" });
    await expect(findUpgradeCandidates({ ...sw, osVersion: "unknown" })).resolves.toMatchObject({ reason: "no-version", platform: "S108FF" });
    expect(prisma.firmwareImage.findMany).not.toHaveBeenCalled();
  });

  it("no-images vs platform-unmatched", async () => {
    stubbed(prisma.firmwareImage.findMany).mockResolvedValue([]);
    stubbed(prisma.firmwareImage.count).mockResolvedValueOnce(0).mockResolvedValueOnce(4);
    await expect(findUpgradeCandidates(sw)).resolves.toMatchObject({ reason: "no-images" });
    await expect(findUpgradeCandidates(sw)).resolves.toMatchObject({ reason: "platform-unmatched" });
  });

  it("current when no primary is strictly newer", async () => {
    stubbed(prisma.firmwareImage.findMany).mockResolvedValue([image({ versionMajor: 7, versionMinor: 4, versionPatch: 3, build: 542 })]);
    await expect(findUpgradeCandidates(sw)).resolves.toMatchObject({ reason: "current", primary: null });
  });

  it("ok: the own-model primary wins, and the same node's newer backup is named", async () => {
    stubbed(prisma.firmwareImage.findMany).mockResolvedValue([
      image({ id: "other-node", model: "FortiSwitch", uploadedAt: new Date("2026-06-01T00:00:00Z") }),
      image({ id: "own" }),
      image({ id: "own-backup", role: "backup", versionMinor: 4, versionPatch: 5, build: 600 }),
      image({ id: "old-backup", model: "FortiSwitch", role: "backup", versionMinor: 2 }),
    ]);
    const res = await findUpgradeCandidates(sw);
    expect(res).toMatchObject({ reason: "ok", engine: "fortiswitch-https", platform: "S108FF", current: { major: 7, minor: 4, patch: 3 } });
    expect(res.primary?.id).toBe("own");
    expect(res.backup?.id).toBe("own-backup");
  });
});

describe("listAssetsForNode / listRecentRuns", () => {
  beforeEach(() => {
    stubbed(prisma.asset.count).mockResolvedValue(0);
    stubbed(prisma.asset.findMany).mockResolvedValue([]);
    stubbed(prisma.firmwareImage.findMany).mockResolvedValue([]);
  });

  it("a manufacturer node spans every firmware type; '(no model)' is asked with noModel, a model narrows", async () => {
    await listAssetsForNode({ manufacturer: "Fortinet" });
    expect(stubbed(prisma.asset.count).mock.calls[0][0].where).toEqual({ manufacturer: "Fortinet", assetType: { in: ["switch", "access_point", "firewall"] }, status: { not: "decommissioned" } });
    await listAssetsForNode({ manufacturer: "Fortinet", assetType: "switch", noModel: true });
    expect(stubbed(prisma.asset.count).mock.calls[1][0].where.OR).toEqual([{ model: null }, { model: "" }]);
    await listAssetsForNode({ manufacturer: "Fortinet", assetType: "switch", model: "S108" });
    expect(stubbed(prisma.asset.count).mock.calls[2][0].where.model).toBe("S108");
    // a model with no type is ignored (it would otherwise widen silently)
    await listAssetsForNode({ manufacturer: "Fortinet", model: "S108" });
    expect(stubbed(prisma.asset.count).mock.calls[3][0].where.model).toBeUndefined();
  });

  it("caps the list at 2000 and reports the true total, with each device's firmware reading", async () => {
    stubbed(prisma.asset.count).mockResolvedValue(2500);
    stubbed(prisma.asset.findMany).mockResolvedValue([{ id: "a", hostname: "sw", ipAddress: null, assetType: "switch", model: "FortiSwitch S108FF", serialNumber: "S108FFTF23000001", osVersion: "7.4.3 build0542", status: "active", monitored: true, monitorStatus: "up", manufacturer: "Fortinet" }]);
    stubbed(prisma.firmwareImage.findMany).mockResolvedValue([image()]);
    const out = await listAssetsForNode({ manufacturer: "Fortinet", assetType: "switch" });
    expect(out.total).toBe(2500);
    expect(out.limit).toBe(2000);
    expect(stubbed(prisma.asset.findMany).mock.calls[0][0].take).toBe(2000);
    expect(out.assets[0]).toMatchObject({ id: "a", firmwareVsPrimary: "older" });
    expect(out.assets[0]).not.toHaveProperty("manufacturer");
  });

  it("listRecentRuns clamps the limit to 1..100 and filters by status when given", async () => {
    stubbed(prisma.firmwareUpgradeRun.findMany).mockResolvedValue([]);
    await listRecentRuns();
    await listRecentRuns({ limit: 0, status: "failed" });
    await listRecentRuns({ limit: 500 });
    const calls = stubbed(prisma.firmwareUpgradeRun.findMany).mock.calls.map((c) => [c[0].take, c[0].where]);
    expect(calls).toEqual([[50, undefined], [1, { status: "failed" }], [100, undefined]]);
  });
});

describe("files on disk", () => {
  it("resolveImagePath stays inside the repository directory", () => {
    expect(resolveImagePath("abc.out")).toBe(resolve(FIRMWARE_DIR, "abc.out"));
    expect(() => resolveImagePath("../escape.out")).toThrow(/escapes the repository directory/);
    expect(() => resolveImagePath(resolve(FIRMWARE_DIR, "..", "x"))).toThrow(/escapes/);
  });

  it("getImage / getImageDownload 404 a missing row; a download 404s a file gone from disk", async () => {
    stubbed(prisma.firmwareImage.findUnique).mockResolvedValue(null);
    await expect(getImage("x")).rejects.toMatchObject({ httpStatus: 404 });
    await expect(getImageDownload("x")).rejects.toMatchObject({ httpStatus: 404 });
    stubbed(prisma.firmwareImage.findUnique).mockResolvedValue({ storagePath: "00000000-0000-0000-0000-000000000000.out", filename: "f.out", sizeBytes: 1 });
    await expect(getImageDownload("x")).rejects.toThrow(/missing from disk/);
  });

  it("getImage reports a missing file instead of failing", async () => {
    stubbed(prisma.firmwareImage.findUnique).mockResolvedValue(image({ storagePath: "00000000-0000-0000-0000-000000000000.out" }));
    await expect(getImage("img-1")).resolves.toMatchObject({ id: "img-1", fileMissing: true, version: { major: 7, minor: 6, patch: 8, build: 1164 } });
  });
});

describe("registerUploadedImage — refusals before any byte is read", () => {
  const tmp = FIRMWARE_INCOMING_DIR + sep + "upload-123";
  const base = { tmpPath: tmp, originalName: "FSW_108F-v7-build1164-FORTINET.out", sizeBytes: 1000, manufacturer: "Fortinet", assetType: "switch", model: "S108" };

  it.each([
    [{ manufacturer: "  " }, 400, /manufacturer is required/],
    [{ assetType: "server" }, 400, /assetType must be/],
    [{ model: " " }, 400, /model is required/],
    [{ sizeBytes: 0 }, 400, /empty/],
    [{ sizeBytes: 104_857_601 }, 413, /Switch firmware images are limited to 104857600 bytes \(100 MiB\)/],
    [{ assetType: "firewall", sizeBytes: 314_572_801 }, 413, /Firewall firmware images are limited to .*\(300 MiB\)/],
  ])("refuses %j and removes the temp upload", async (over, status, msg) => {
    const err = await registerUploadedImage({ ...base, ...over } as never).catch((e) => e);
    expect(err.httpStatus).toBe(status);
    expect(err.message).toMatch(msg);
    expect(h.rm).toHaveBeenCalledWith(tmp, { force: true });
    expect(prisma.firmwareImage.create).not.toHaveBeenCalled();
  });

  it("a path outside the incoming directory is refused and NOT removed", async () => {
    await expect(registerUploadedImage({ ...base, tmpPath: resolve(FIRMWARE_DIR, "..", "elsewhere") })).rejects.toMatchObject({ httpStatus: 400 });
    expect(h.rm).not.toHaveBeenCalled();
  });
});
