/**
 * tests/unit/llmToolCheck.test.ts
 *
 * checkLlmToolCalling (business rule 95) — the check the integration form
 * runs after every save of an AI Assistant:
 *   - it asks the model the integration will really chat with (the configured
 *     one as the server names it, or the default pick for a blank Model);
 *   - it stamps { model, result, at } on config.toolCheck WITHOUT clobbering
 *     an edit saved while the probe ran;
 *   - it writes an audit Event, a warning when the model cannot call tools;
 *   - it refuses other integration types and a server with no chat model.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  logEvent: vi.fn(async () => {}),
  listModels: vi.fn(),
  probeToolCalling: vi.fn(),
}));

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: h.logEvent }));
vi.mock("../../src/services/llmService.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/services/llmService.js")>("../../src/services/llmService.js");
  return { ...actual, listModels: h.listModels, probeToolCalling: h.probeToolCalling };
});

import { checkLlmToolCalling } from "../../src/services/llmIntegrationService.js";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";

const db = {
  findUnique: stubbed(prisma.integration.findUnique),
  update: stubbed(prisma.integration.update),
};

const row = (config: Record<string, unknown>, type = "llm") => ({ id: "i1", name: "Ollama", type, config });

beforeEach(() => {
  resetDbStub();
  vi.clearAllMocks();
  h.listModels.mockResolvedValue([
    { id: "llama2:latest", toolCalling: "no", toolCallingSource: "ollama", embedding: false },
    { id: "qwen2.5:7b", toolCalling: "yes", toolCallingSource: "ollama", embedding: false },
  ]);
});

describe("checkLlmToolCalling", () => {
  it("probes the configured model under the server's own name and stamps the verdict", async () => {
    db.findUnique
      .mockResolvedValueOnce(row({ host: "h", model: "llama2" }))
      // An edit saved while the probe ran is what gets written back.
      .mockResolvedValueOnce({ config: { host: "h", model: "llama2", temperature: 0.7 } });
    h.probeToolCalling.mockResolvedValueOnce("no");
    const out = await checkLlmToolCalling("i1", "dana");
    expect(h.probeToolCalling).toHaveBeenCalledWith(expect.objectContaining({ host: "h" }), "llama2:latest");
    expect(out).toMatchObject({ model: "llama2:latest", result: "no" });
    expect(Date.parse(out.at)).not.toBeNaN();
    const written = (db.update.mock.calls[0] as any)[0].data.config;
    expect(written).toMatchObject({ temperature: 0.7, toolCheck: { model: "llama2:latest", result: "no" } });
    expect(h.logEvent).toHaveBeenCalledWith(expect.objectContaining({ action: "integration.llm.tool_check", level: "warning", actor: "dana" }));
  });

  it("probes the default pick when Model is blank", async () => {
    db.findUnique.mockResolvedValueOnce(row({ host: "h", model: "" })).mockResolvedValueOnce({ config: { host: "h" } });
    h.probeToolCalling.mockResolvedValueOnce("yes");
    const out = await checkLlmToolCalling("i1", "dana");
    expect(out.model).toBe("qwen2.5:7b");
    expect(h.logEvent).toHaveBeenCalledWith(expect.objectContaining({ level: "info" }));
  });

  it("Azure AI Foundry: probes the deployment directly, never listing models (rule 95(j))", async () => {
    db.findUnique.mockResolvedValueOnce(row({ provider: "azure", host: "res.openai.azure.com", model: "gpt-4o-prod" }))
      .mockResolvedValueOnce({ config: { provider: "azure", host: "res.openai.azure.com", model: "gpt-4o-prod" } });
    h.probeToolCalling.mockResolvedValueOnce("yes");
    const out = await checkLlmToolCalling("i1", "dana");
    expect(out.model).toBe("gpt-4o-prod");
    expect(h.listModels).not.toHaveBeenCalled();
    db.findUnique.mockResolvedValueOnce(row({ provider: "azure", host: "res.openai.azure.com", model: "" }));
    await expect(checkLlmToolCalling("i1", "dana")).rejects.toMatchObject({ httpStatus: 409 });
    expect(h.listModels).not.toHaveBeenCalled();
  });

  it("refuses a missing integration, another type, and a server with no chat model", async () => {
    db.findUnique.mockResolvedValueOnce(null);
    await expect(checkLlmToolCalling("i1", "dana")).rejects.toMatchObject({ httpStatus: 404 });
    db.findUnique.mockResolvedValueOnce(row({ host: "h" }, "fortigate"));
    await expect(checkLlmToolCalling("i1", "dana")).rejects.toMatchObject({ httpStatus: 400 });
    db.findUnique.mockResolvedValueOnce(row({ host: "h", model: "" }));
    h.listModels.mockResolvedValueOnce([]);
    await expect(checkLlmToolCalling("i1", "dana")).rejects.toMatchObject({ httpStatus: 409 });
    expect(db.update).not.toHaveBeenCalled();
  });

  it("stores nothing when the server cannot be reached", async () => {
    db.findUnique.mockResolvedValueOnce(row({ host: "h", model: "qwen2.5:7b" }));
    h.probeToolCalling.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
    await expect(checkLlmToolCalling("i1", "dana")).rejects.toThrow(/ECONNREFUSED/);
    expect(db.update).not.toHaveBeenCalled();
    expect(h.logEvent).not.toHaveBeenCalled();
  });
});
