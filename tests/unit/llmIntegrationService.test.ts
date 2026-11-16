/**
 * tests/unit/llmIntegrationService.test.ts
 *
 * The role + API token an `llm` integration provisions for its model server
 * (business rule 95(f)), the repoint-key diff (rule 111(e)), the caller bar
 * (rules 48 / 114(g)) and the post-save tool-calling check (rule 95(j)).
 * Role / token creation and the model server are mocked; the permission
 * matrix and the caller checks are the real ones.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request } from "express";

const h = vi.hoisted(() => ({
  createRole: vi.fn(),
  deleteRole: vi.fn(),
  createToken: vi.fn(),
  deleteToken: vi.fn(),
  listModels: vi.fn(),
  probeToolCalling: vi.fn(),
}));

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) => import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
vi.mock("../../src/services/roleService.js", () => ({ createRole: h.createRole, deleteRole: h.deleteRole }));
vi.mock("../../src/services/apiTokenService.js", () => ({ createToken: h.createToken, deleteToken: h.deleteToken }));
vi.mock("../../src/services/llmService.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/services/llmService.js")>("../../src/services/llmService.js");
  return { ...actual, listModels: h.listModels, probeToolCalling: h.probeToolCalling };
});

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
import { AppError } from "../../src/utils/errors.js";
import { FUNCTION_KEYS, keySupportsLevel } from "../../src/api/middleware/permissions.js";
import {
  BOT_EXCLUDED_KEYS,
  botPermissions,
  botRoleBaseName,
  llmRepointKeys,
  assertCanProvision,
  provisionLlmAccess,
  regenerateLlmToken,
  checkLlmToolCalling,
  deprovisionLlmAccess,
} from "../../src/services/llmIntegrationService.js";

const role = {
  findFirst: stubbed(prisma.role.findFirst),
  findUnique: stubbed(prisma.role.findUnique),
};
const apiToken = { findUnique: stubbed(prisma.apiToken.findUnique) };
const integ = {
  findUnique: stubbed(prisma.integration.findUnique),
  update: stubbed(prisma.integration.update),
};

/** Every key at `level`, with overrides. */
function matrix(level: string, over: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const def of FUNCTION_KEYS) out[def.key] = level;
  return { ...out, ...over };
}
function reqWith(permissions: Record<string, string> | null): Request {
  return (permissions ? { roleSnapshot: { permissions } } : {}) as unknown as Request;
}
/** Read everywhere + roles / apiTokens write: enough to provision, not admin. */
const PROVISIONER = matrix("read", { roles: "write", apiTokens: "write" });

async function rejection(p: Promise<unknown> | (() => unknown)): Promise<AppError> {
  try {
    if (typeof p === "function") p();
    else await p;
  } catch (err) {
    return err as AppError;
  }
  throw new Error("expected a rejection");
}

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
  vi.clearAllMocks();
  h.createRole.mockReset().mockImplementation(async (input: any) => ({ id: "role-1", name: input.name }));
  h.deleteRole.mockReset().mockResolvedValue(undefined);
  h.createToken.mockReset().mockResolvedValue({ token: { id: "tok-1" }, rawToken: "pol_raw" });
  h.deleteToken.mockReset().mockResolvedValue(undefined);
  role.findFirst.mockResolvedValue(null);
  apiToken.findUnique.mockResolvedValue(null);
});

// ─── The bot role ─────────────────────────────────────────────────────────

describe("botPermissions", () => {
  it("is read on every non-excluded key with a read rung and none everywhere else", () => {
    const perms = botPermissions();
    for (const def of FUNCTION_KEYS) {
      const want = !BOT_EXCLUDED_KEYS.has(def.key) && keySupportsLevel(def.key, "read") ? "read" : "none";
      expect(perms[def.key], def.key).toBe(want);
    }
  });

  it("returns a fresh object each call", () => {
    const a = botPermissions();
    a.assets = "fullwrite";
    expect(botPermissions().assets).toBe("read");
  });
});

describe("botRoleBaseName", () => {
  it("slugs the integration name under llm-", () => {
    expect(botRoleBaseName("Ollama Prod!")).toBe("llm-ollama-prod");
    expect(botRoleBaseName("--GPU__box--")).toBe("llm-gpu__box");
    expect(botRoleBaseName("Café")).toBe("llm-caf");
  });

  it("falls back to llm-assistant when nothing survives the slug", () => {
    expect(botRoleBaseName("")).toBe("llm-assistant");
    expect(botRoleBaseName("★★★")).toBe("llm-assistant");
  });

  it("keeps the slug to 24 characters (28 total, inside the role-name limit)", () => {
    const out = botRoleBaseName("a".repeat(80));
    expect(out).toBe(`llm-${"a".repeat(24)}`);
    expect(out).toMatch(/^[A-Za-z0-9_-]{2,32}$/);
  });
});

// ─── llmRepointKeys (rule 111(e)) ─────────────────────────────────────────

describe("llmRepointKeys", () => {
  const base = { provider: "openai", host: "10.0.0.5", port: 11434, basePath: "/v1", useHttps: false, allowLoopback: false, azureApiShape: "v1", systemPromptExtra: "", model: "llama3" };

  it("is empty when nothing that decides the destination changed — the model is not one", () => {
    expect(llmRepointKeys(base, { ...base, model: "qwen2.5:7b" })).toEqual([]);
  });

  it("names every destination key that moved", () => {
    expect(llmRepointKeys(base, { ...base, host: "10.0.0.6", useHttps: true, systemPromptExtra: "Be terse" }))
      .toEqual(["host", "useHttps", "systemPromptExtra"]);
    expect(llmRepointKeys(base, { ...base, provider: "azure", port: 443, basePath: "", allowLoopback: true, azureApiShape: "legacy" }))
      .toEqual(["provider", "port", "basePath", "allowLoopback", "azureApiShape"]);
  });

  it("compares strings trimmed", () => {
    expect(llmRepointKeys(base, { ...base, host: " 10.0.0.5 ", systemPromptExtra: "   " })).toEqual([]);
  });

  it("an old row without provider / azureApiShape / allowLoopback / systemPromptExtra compares as the defaults", () => {
    const old = { host: "h", port: 1, basePath: "/v1", useHttps: false };
    expect(llmRepointKeys(old, { ...old, provider: "openai", azureApiShape: "v1", allowLoopback: false, systemPromptExtra: "" })).toEqual([]);
    expect(llmRepointKeys(old, { ...old, provider: "azure" })).toEqual(["provider"]);
    expect(llmRepointKeys(old, { ...old, allowLoopback: true })).toEqual(["allowLoopback"]);
  });

  it("skips a key with no default that the stored row never had", () => {
    expect(llmRepointKeys({}, { host: "new", port: 9, basePath: "/x", useHttps: true })).toEqual([]);
  });

  it("counts a key the next config drops back to its default", () => {
    expect(llmRepointKeys({ ...base, provider: "azure" }, { ...base, provider: undefined })).toEqual(["provider"]);
  });
});

// ─── assertCanProvision ───────────────────────────────────────────────────

describe("assertCanProvision", () => {
  it("passes a caller with roles + apiTokens write who already reads what the bot reads", () => {
    expect(() => assertCanProvision(reqWith(PROVISIONER))).not.toThrow();
  });

  it("refuses (403) without roles write or without apiTokens write", async () => {
    const overs: Record<string, string>[] = [{ roles: "read" }, { apiTokens: "read" }, { roles: "none", apiTokens: "none" }];
    for (const over of overs) {
      const err = await rejection(() => assertCanProvision(reqWith({ ...PROVISIONER, ...over })));
      expect(err).toBeInstanceOf(AppError);
      expect(err.httpStatus).toBe(403);
      expect(err.message).toMatch(/Roles Read-Write and API Tokens Read-Write/);
    }
  });

  it("refuses (403) a caller who cannot read everything the bot role would read (rule 48)", async () => {
    const err = await rejection(() => assertCanProvision(reqWith({ ...PROVISIONER, assets: "none" })));
    expect(err.httpStatus).toBe(403);
    expect(err.message).toMatch(/assets=read/);
  });

  it("refuses a request with no role snapshot", async () => {
    expect((await rejection(() => assertCanProvision(reqWith(null)))).httpStatus).toBe(403);
  });

  it("lets an admin-equivalent caller through", () => {
    expect(() => assertCanProvision(reqWith(matrix("fullwrite")))).not.toThrow();
  });
});

// ─── provisionLlmAccess ───────────────────────────────────────────────────

describe("provisionLlmAccess", () => {
  it("creates the read-only llm- role, mints a token on it and returns the raw token once", async () => {
    const out = await provisionLlmAccess({ id: "i1", name: "Ollama" }, "alice");
    expect(out).toEqual({ roleId: "role-1", roleName: "llm-ollama", tokenId: "tok-1", tokenName: "LLM: Ollama", rawToken: "pol_raw" });
    const roleInput = h.createRole.mock.calls[0][0];
    expect(roleInput.name).toBe("llm-ollama");
    expect(roleInput.permissions).toEqual(botPermissions());
    expect(h.createRole.mock.calls[0][1]).toBe("alice");
    expect(h.createToken).toHaveBeenCalledWith({ name: "LLM: Ollama", roleId: "role-1", createdBy: "alice" });
  });

  it("writes an audit Event naming the role and token, never the raw token", async () => {
    await provisionLlmAccess({ id: "i1", name: "Ollama" }, "alice");
    expect(eventLog.logEvent).toHaveBeenCalledTimes(1);
    const ev = eventLog.logEvent.mock.calls[0][0];
    expect(ev).toMatchObject({
      action: "integration.llm.provisioned", resourceType: "integration", resourceId: "i1", resourceName: "Ollama", actor: "alice",
      details: { roleId: "role-1", tokenId: "tok-1" },
    });
    expect(JSON.stringify(ev)).not.toContain("pol_raw");
  });

  it("picks the next free role name, case-insensitively", async () => {
    role.findFirst.mockResolvedValueOnce({ id: "x" }).mockResolvedValueOnce({ id: "y" }).mockResolvedValue(null);
    const out = await provisionLlmAccess({ id: "i1", name: "Ollama" }, "alice");
    expect(out.roleName).toBe("llm-ollama-3");
    expect(role.findFirst.mock.calls[0][0].where).toEqual({ name: { equals: "llm-ollama", mode: "insensitive" } });
    expect(role.findFirst.mock.calls[1][0].where.name.equals).toBe("llm-ollama-2");
  });

  it("a suffixed role name still fits 32 characters", async () => {
    role.findFirst.mockResolvedValueOnce({ id: "x" }).mockResolvedValue(null);
    const out = await provisionLlmAccess({ id: "i1", name: "z".repeat(60) }, "alice");
    expect(out.roleName).toMatch(/^[A-Za-z0-9_-]{2,32}$/);
    expect(out.roleName.endsWith("-2")).toBe(true);
  });

  it("picks the next free token name", async () => {
    apiToken.findUnique.mockResolvedValueOnce({ id: "t" }).mockResolvedValue(null);
    const out = await provisionLlmAccess({ id: "i1", name: "Ollama" }, "alice");
    expect(out.tokenName).toBe("LLM: Ollama (2)");
  });

  it("409s after 50 clashing role names, before creating anything", async () => {
    role.findFirst.mockResolvedValue({ id: "x" });
    const err = await rejection(provisionLlmAccess({ id: "i1", name: "Ollama" }, "alice"));
    expect(err.httpStatus).toBe(409);
    expect(role.findFirst).toHaveBeenCalledTimes(50);
    expect(h.createRole).not.toHaveBeenCalled();
  });

  it("deletes the role again when the token cannot be minted, and rethrows", async () => {
    h.createToken.mockRejectedValue(new AppError(500, "token store down"));
    const err = await rejection(provisionLlmAccess({ id: "i1", name: "Ollama" }, "alice"));
    expect(err.message).toBe("token store down");
    expect(h.deleteRole).toHaveBeenCalledWith("role-1", "alice");
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });

  it("deletes the role when every token name clashes, and a failing clean-up does not mask the error", async () => {
    apiToken.findUnique.mockResolvedValue({ id: "t" });
    h.deleteRole.mockRejectedValue(new Error("FK"));
    const err = await rejection(provisionLlmAccess({ id: "i1", name: "Ollama" }, "alice"));
    expect(err.httpStatus).toBe(409);
    expect(err.message).toMatch(/token name/);
    expect(h.deleteRole).toHaveBeenCalledTimes(1);
  });

  it("caps the token base name at 100 characters", async () => {
    await provisionLlmAccess({ id: "i1", name: "n".repeat(150) }, "alice");
    expect(h.createToken.mock.calls[0][0].name).toHaveLength(100);
  });

  // Was a bug until 2026-11-14: roleService.createRole refuses a description over 200 characters
  // (400 "Description must be ≤ 200 characters"), and an integration name has
  // no length cap (IntegrationNameSchema: min 1, no max). provisionLlmAccess
  // builds `Read-only access for the "<name>" AI Assistant integration's API
  // token. Managed by that integration.` without trimming the name, so a
  // 150-character name yields a ~240-character description, createRole
  // throws 400, and POST /integrations rolls the llm integration back.
  // Right: the description fits 200 (truncate the quoted name), as the token
  // name already does with `.slice(0, 100)`.
  it("passes createRole a description within roleService's 200-character limit for a long integration name", async () => {
    await provisionLlmAccess({ id: "i1", name: "Nashville datacentre GPU inference host ".repeat(4) }, "alice");
    expect((h.createRole.mock.calls[0][0].description as string).length).toBeLessThanOrEqual(200);
  });
});

// ─── regenerateLlmToken ───────────────────────────────────────────────────

describe("regenerateLlmToken", () => {
  const integration = { id: "i1", name: "Ollama", config: { roleId: "role-1", tokenId: "old-tok" } };

  beforeEach(() => {
    role.findUnique.mockResolvedValue({ id: "role-1", name: "llm-ollama", permissions: botPermissions() });
  });

  it("409s when the integration's role is gone or was never recorded", async () => {
    role.findUnique.mockResolvedValue(null);
    expect((await rejection(regenerateLlmToken(integration, "alice"))).httpStatus).toBe(409);
    expect((await rejection(regenerateLlmToken({ ...integration, config: {} }, "alice"))).httpStatus).toBe(409);
    expect(h.deleteToken).not.toHaveBeenCalled();
  });

  it("mints a new token on the same role, points the config at it, then deletes the old one and logs a warning", async () => {
    // Was a bug until 2026-11-16: the old token was deleted BEFORE the new one was minted, so a failed mint left the integration with no token.
    const out = await regenerateLlmToken(integration, "alice");
    expect(out).toEqual({ tokenId: "tok-1", tokenName: "LLM: Ollama", rawToken: "pol_raw", roleName: "llm-ollama" });
    expect(h.deleteToken).toHaveBeenCalledWith("old-tok");
    expect(h.createToken).toHaveBeenCalledWith({ name: "LLM: Ollama", roleId: "role-1", createdBy: "alice" });
    expect(integ.update).toHaveBeenCalledWith({ where: { id: "i1" }, data: { config: { roleId: "role-1", tokenId: "tok-1" } } });
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({
      action: "integration.llm.token_regenerated", level: "warning", resourceId: "i1",
      details: { oldTokenId: "old-tok", tokenId: "tok-1" },
    });
    expect(h.createToken.mock.invocationCallOrder[0]).toBeLessThan(integ.update.mock.invocationCallOrder[0]);
    expect(integ.update.mock.invocationCallOrder[0]).toBeLessThan(h.deleteToken.mock.invocationCallOrder[0]);
  });

  it("a failed mint leaves the old token and the config untouched", async () => {
    h.createToken.mockRejectedValueOnce(new AppError(500, "mint failed"));
    expect((await rejection(regenerateLlmToken(integration, "alice"))).httpStatus).toBe(500);
    expect(h.deleteToken).not.toHaveBeenCalled();
    expect(integ.update).not.toHaveBeenCalled();
  });

  it("a failed config write deletes the new token, keeps the old one, and rethrows", async () => {
    integ.update.mockRejectedValueOnce(new Error("db down"));
    await expect(regenerateLlmToken(integration, "alice")).rejects.toThrow("db down");
    expect(h.deleteToken).toHaveBeenCalledTimes(1);
    expect(h.deleteToken).toHaveBeenCalledWith("tok-1");
  });

  it("carries on when the old token was already deleted by hand", async () => {
    h.deleteToken.mockRejectedValue(new AppError(404, "gone"));
    await expect(regenerateLlmToken(integration, "alice")).resolves.toMatchObject({ tokenId: "tok-1" });
  });

  it("skips the delete when no old token is recorded", async () => {
    await regenerateLlmToken({ ...integration, config: { roleId: "role-1" } }, "alice");
    expect(h.deleteToken).not.toHaveBeenCalled();
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({ details: { oldTokenId: null } });
  });

  it("with the request, checks the caller BEFORE the old token dies (rule 114(k))", async () => {
    const err = await rejection(regenerateLlmToken(integration, "bob", reqWith({ ...PROVISIONER, apiTokens: "read" })));
    expect(err.httpStatus).toBe(403);
    expect(h.deleteToken).not.toHaveBeenCalled();
    expect(h.createToken).not.toHaveBeenCalled();
  });

  it("with the request, refuses when an operator widened the stored role past the caller", async () => {
    role.findUnique.mockResolvedValue({ id: "role-1", name: "llm-ollama", permissions: { ...botPermissions(), credentials: "read" } });
    const err = await rejection(regenerateLlmToken(integration, "bob", reqWith({ ...PROVISIONER, credentials: "none" })));
    expect(err.httpStatus).toBe(403);
    expect(err.message).toMatch(/credentials=read/);
    expect(h.deleteToken).not.toHaveBeenCalled();
  });

  it("with the request, passes a caller who holds what the role grants", async () => {
    await expect(regenerateLlmToken(integration, "bob", reqWith(PROVISIONER))).resolves.toMatchObject({ rawToken: "pol_raw" });
  });
});

// ─── checkLlmToolCalling ──────────────────────────────────────────────────

describe("checkLlmToolCalling", () => {
  const row = (config: Record<string, unknown>, type = "llm") => ({ id: "i1", name: "Ollama", type, config });

  it("404s a missing integration and 400s another type", async () => {
    integ.findUnique.mockResolvedValueOnce(null);
    expect((await rejection(checkLlmToolCalling("i1", "a"))).httpStatus).toBe(404);
    integ.findUnique.mockResolvedValueOnce(row({}, "vcenter"));
    expect((await rejection(checkLlmToolCalling("i1", "a"))).httpStatus).toBe(400);
  });

  it("Azure with a blank Model 409s without listing or probing", async () => {
    integ.findUnique.mockResolvedValueOnce(row({ provider: "azure", host: "x.services.ai.azure.com", model: "  " }));
    expect((await rejection(checkLlmToolCalling("i1", "a"))).httpStatus).toBe(409);
    expect(h.listModels).not.toHaveBeenCalled();
    expect(h.probeToolCalling).not.toHaveBeenCalled();
  });

  it("probes a configured model the server does not list under its own spelling", async () => {
    integ.findUnique.mockResolvedValueOnce(row({ host: "h", model: "custom-model" })).mockResolvedValueOnce({ config: { host: "h" } });
    h.listModels.mockResolvedValue([{ id: "other", toolCalling: "unknown" }]);
    h.probeToolCalling.mockResolvedValue("unknown");
    const out = await checkLlmToolCalling("i1", "alice");
    expect(out.model).toBe("custom-model");
    expect(out.result).toBe("unknown");
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({ level: "info", details: { model: "custom-model", result: "unknown" } });
    expect(eventLog.logEvent.mock.calls[0][0].message).toMatch(/could not be determined/);
  });

  it("still logs the verdict when the integration was deleted during the probe, writing nothing", async () => {
    integ.findUnique.mockResolvedValueOnce(row({ host: "h", model: "m" })).mockResolvedValueOnce(null);
    h.listModels.mockResolvedValue([{ id: "m" }]);
    h.probeToolCalling.mockResolvedValue("no");
    await checkLlmToolCalling("i1", "alice");
    expect(integ.update).not.toHaveBeenCalled();
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({ action: "integration.llm.tool_check", level: "warning" });
  });

  it("stamps toolCheck over the FRESH config, keeping an edit saved meanwhile", async () => {
    integ.findUnique.mockResolvedValueOnce(row({ host: "h", model: "m" })).mockResolvedValueOnce({ config: { host: "h", model: "m", systemPromptExtra: "new" } });
    h.listModels.mockResolvedValue([{ id: "m" }]);
    h.probeToolCalling.mockResolvedValue("yes");
    const out = await checkLlmToolCalling("i1", "alice");
    const written = integ.update.mock.calls[0][0].data.config;
    expect(written).toMatchObject({ systemPromptExtra: "new", toolCheck: { model: "m", result: "yes", at: out.at } });
    expect(eventLog.logEvent.mock.calls[0][0].message).toMatch(/calls tools/);
  });
});

// ─── deprovisionLlmAccess ─────────────────────────────────────────────────

describe("deprovisionLlmAccess", () => {
  const integration = { id: "i1", name: "Ollama", config: { roleId: "role-1", tokenId: "tok-1" } };

  it("deletes the token first, then the role, and logs info", async () => {
    await deprovisionLlmAccess(integration, "alice");
    expect(h.deleteToken).toHaveBeenCalledWith("tok-1");
    expect(h.deleteRole).toHaveBeenCalledWith("role-1", "alice");
    expect(h.deleteToken.mock.invocationCallOrder[0]).toBeLessThan(h.deleteRole.mock.invocationCallOrder[0]);
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({ action: "integration.llm.deprovisioned", level: "info", resourceId: "i1", actor: "alice" });
  });

  it("treats an already-deleted token or role (404) as done", async () => {
    h.deleteToken.mockRejectedValue(new AppError(404, "no token"));
    h.deleteRole.mockRejectedValue(new AppError(404, "no role"));
    await deprovisionLlmAccess(integration, "alice");
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({ level: "info" });
  });

  it("never throws on another failure; it names what was left behind in a warning", async () => {
    h.deleteToken.mockRejectedValue(new Error("db down"));
    h.deleteRole.mockRejectedValue(new AppError(409, "role still has users"));
    await expect(deprovisionLlmAccess(integration, "alice")).resolves.toBeUndefined();
    const ev = eventLog.logEvent.mock.calls[0][0];
    expect(ev.level).toBe("warning");
    expect(ev.message).toContain("token: db down");
    expect(ev.message).toContain("role: role still has users");
  });

  it("does nothing but log when no ids are recorded", async () => {
    await deprovisionLlmAccess({ id: "i1", name: "Ollama", config: { roleId: 5, tokenId: null } }, "alice");
    expect(h.deleteToken).not.toHaveBeenCalled();
    expect(h.deleteRole).not.toHaveBeenCalled();
    expect(eventLog.logEvent).toHaveBeenCalledTimes(1);
  });
});
