/**
 * tests/unit/llmAnthropicFoundry.test.ts
 *
 * Claude deployments on Azure AI Foundry (business rule 95(j), API shape
 * "anthropic"): the request translation from the orchestrator's OpenAI-shaped
 * history, the base URL and Entra scope, and a full round through Anthropic's
 * official Foundry SDK against a local HTTP server speaking the Messages API
 * event stream — text, a tool call with thinking blocks replayed verbatim,
 * key vs Entra auth (with the SDK's env-var fallbacks kept out), error
 * wording, Stop, and the idle timeout. No test reaches Azure.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  ANTHROPIC_MAX_TOKENS,
  anthropicBaseUrl,
  azureScope,
  chatCompletionRound,
  parseAzureEndpoint,
  testConnection,
  toAnthropicRequest,
  _clearEntraTokenCache,
  type ChatMessage,
  type ChatToolDef,
  type LlmConfig,
} from "../../src/services/llmService.js";

type Handler = (req: http.IncomingMessage, body: any, res: http.ServerResponse) => void;
let handler: Handler = () => {};
let server: http.Server;
let port = 0;
const seen: Array<{ url: string; headers: http.IncomingHttpHeaders; body: any }> = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body: any = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
      seen.push({ url: req.url ?? "", headers: req.headers, body });
      handler(req, body, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }));

beforeEach(() => {
  seen.length = 0;
  _clearEntraTokenCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const claude = (over: Partial<LlmConfig> = {}): LlmConfig => ({
  provider: "azure",
  azureApiShape: "anthropic",
  host: "127.0.0.1",
  port,
  useHttps: false,
  basePath: "",
  model: "claude-haiku-5-5",
  apiToken: "foundry-key",
  requestTimeoutMs: 10_000,
  ...over,
});

/** Write one Messages API stream: each entry is an event object (its `type` names the SSE event). */
function messageStream(res: http.ServerResponse, events: Array<Record<string, unknown>>) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  res.end();
}

const start = { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } };
const stop = (reason: string) => [
  { type: "message_delta", delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 5 } },
  { type: "message_stop" },
];

const textReply: Handler = (_req, _b, res) => messageStream(res, [
  start,
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Two " } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "switches are down." } },
  { type: "content_block_stop", index: 0 },
  ...stop("end_turn"),
]);

const toolReply: Handler = (_req, _b, res) => messageStream(res, [
  start,
  { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Need the alert list." } },
  { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-abc" } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "list_alerts", input: {} } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"sever" } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "ity\":\"critical\"}" } },
  { type: "content_block_stop", index: 1 },
  ...stop("tool_use"),
]);

function apiError(res: http.ServerResponse, status: number, type: string, message: string) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ type: "error", error: { type, message } }));
}

const TOOL: ChatToolDef = { type: "function", function: { name: "list_alerts", description: "List alerts", parameters: { type: "object", properties: { severity: { type: "string" } } } } };

// ─── Pure helpers ────────────────────────────────────────────────────────────

describe("toAnthropicRequest", () => {
  it("lifts leading system messages, groups tool results, and keeps a later system note on the user turn", () => {
    const msgs: ChatMessage[] = [
      { role: "system", content: "You are Polaris." },
      { role: "user", content: "anything critical?" },
      { role: "assistant", content: null, tool_calls: [
        { id: "a", type: "function", function: { name: "list_alerts", arguments: "{\"severity\":\"critical\"}" } },
        { id: "b", type: "function", function: { name: "fleet_summary", arguments: "not json" } },
      ] },
      { role: "tool", tool_call_id: "a", content: "{\"total\":1}" },
      { role: "tool", tool_call_id: "b", content: "{\"down\":1}" },
      { role: "system", content: "Drop the character." },
    ];
    const r = toAnthropicRequest(msgs, [TOOL]);
    expect(r.system).toBe("You are Polaris.");
    expect(r.messages).toEqual([
      { role: "user", content: "anything critical?" },
      { role: "assistant", content: [
        { type: "tool_use", id: "a", name: "list_alerts", input: { severity: "critical" } },
        { type: "tool_use", id: "b", name: "fleet_summary", input: {} },
      ] },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "a", content: "{\"total\":1}" },
        { type: "tool_result", tool_use_id: "b", content: "{\"down\":1}" },
        { type: "text", text: "Drop the character." },
      ] },
    ]);
    expect(r.tools).toEqual([{ name: "list_alerts", description: "List alerts", input_schema: TOOL.function.parameters }]);
  });

  it("replays an assistant turn's raw blocks verbatim (thinking + signature included)", () => {
    const raw = [{ type: "thinking", thinking: "", signature: "sig" }, { type: "tool_use", id: "t", name: "x", input: {} }];
    const r = toAnthropicRequest([
      { role: "user", content: "q" },
      { role: "assistant", content: "ignored", tool_calls: [{ id: "t", type: "function", function: { name: "x", arguments: "{}" } }], raw },
      { role: "tool", tool_call_id: "t", content: "ok" },
    ], []);
    expect(r.messages[1]).toEqual({ role: "assistant", content: raw });
  });

  it("history turns stay plain strings and an empty assistant turn is dropped", () => {
    const r = toAnthropicRequest([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "assistant", content: "" },
      { role: "user", content: "again" },
    ], []);
    expect(r.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "again" },
    ]);
  });
});

describe("endpoint, base URL and scope", () => {
  it("a pasted Claude Target URI drops everything from /anthropic", () => {
    expect(parseAzureEndpoint("https://res.services.ai.azure.com/anthropic/v1/messages"))
      .toEqual({ host: "res.services.ai.azure.com", port: 443, useHttps: true, basePath: "" });
  });

  it("builds the SDK base URL with the gateway prefix and a non-default port only", () => {
    expect(anthropicBaseUrl(claude({ host: "res.services.ai.azure.com", port: 443, useHttps: true }))).toBe("https://res.services.ai.azure.com/anthropic/");
    expect(anthropicBaseUrl(claude({ host: "apim.example.com", port: 8443, useHttps: true, basePath: "/ai" }))).toBe("https://apim.example.com:8443/ai/anthropic/");
  });

  it("defaults the Entra scope per shape, and an operator value wins", () => {
    expect(azureScope(claude())).toBe("https://ai.azure.com/.default");
    expect(azureScope(claude({ azureApiShape: "v1" }))).toBe("https://cognitiveservices.azure.com/.default");
    expect(azureScope(claude({ azureScope: "https://custom/.default" }))).toBe("https://custom/.default");
  });
});

// ─── Through the SDK ─────────────────────────────────────────────────────────

describe("chatCompletionRound on a Claude deployment", () => {
  it("posts to /anthropic/v1/messages with the key, no temperature, and streams text", async () => {
    handler = textReply;
    const parts: string[] = [];
    const r = await chatCompletionRound(claude({ temperature: 0.7 }), [
      { role: "system", content: "You are Polaris." },
      { role: "user", content: "what is down?" },
    ], [TOOL], { onText: (t) => parts.push(t) });
    expect(parts).toEqual(["Two ", "switches are down."]);
    expect(r).toMatchObject({ content: "Two switches are down.", toolCalls: [], finishReason: "stop" });
    expect(seen[0].url).toBe("/anthropic/v1/messages");
    expect(seen[0].headers["x-api-key"]).toBe("foundry-key");
    expect(seen[0].headers.authorization).toBeUndefined();
    expect(seen[0].headers["anthropic-version"]).toBeTruthy();
    expect(seen[0].body).toMatchObject({ model: "claude-haiku-5-5", max_tokens: ANTHROPIC_MAX_TOKENS, system: "You are Polaris.", stream: true, tool_choice: { type: "auto" } });
    expect(seen[0].body).not.toHaveProperty("temperature");
    expect(seen[0].body).not.toHaveProperty("thinking");
  });

  it("returns a tool call with its arguments joined, and the raw blocks for replay", async () => {
    handler = toolReply;
    let reasoning = 0;
    const r = await chatCompletionRound(claude(), [{ role: "user", content: "anything critical?" }], [TOOL], { onReasoning: (n) => { reasoning = n; } });
    expect(r.finishReason).toBe("tool_calls");
    expect(r.toolCalls).toEqual([{ id: "toolu_1", type: "function", function: { name: "list_alerts", arguments: "{\"severity\":\"critical\"}" } }]);
    expect(reasoning).toBe("Need the alert list.".length);
    expect(r.raw).toEqual([
      { type: "thinking", thinking: "Need the alert list.", signature: "sig-abc" },
      { type: "tool_use", id: "toolu_1", name: "list_alerts", input: { severity: "critical" } },
    ]);
  });

  it("no tools offered → no tools or tool_choice sent", async () => {
    handler = textReply;
    await chatCompletionRound(claude(), [{ role: "user", content: "hi" }], []);
    expect(seen[0].body).not.toHaveProperty("tools");
    expect(seen[0].body).not.toHaveProperty("tool_choice");
  });

  it("never picks up ANTHROPIC_FOUNDRY_* from the environment", async () => {
    vi.stubEnv("ANTHROPIC_FOUNDRY_API_KEY", "env-key-must-not-be-used");
    vi.stubEnv("ANTHROPIC_FOUNDRY_RESOURCE", "env-resource");
    vi.stubEnv("ANTHROPIC_FOUNDRY_BASE_URL", "https://env.example.com/anthropic/");
    handler = textReply;
    await chatCompletionRound(claude(), [{ role: "user", content: "hi" }], []);
    expect(seen[0].headers["x-api-key"]).toBe("foundry-key");
  });

  it("Entra: a Bearer token for https://ai.azure.com/.default, and no key header even with one in the environment", async () => {
    vi.stubEnv("ANTHROPIC_FOUNDRY_API_KEY", "env-key-must-not-be-used");
    const realFetch = globalThis.fetch;
    const tokenCalls: string[] = [];
    vi.stubGlobal("fetch", async (url: any, init?: any) => {
      if (String(url).startsWith("https://login.microsoftonline.com/")) {
        tokenCalls.push(new URLSearchParams(String(init?.body)).get("scope") ?? "");
        return new Response(JSON.stringify({ access_token: "aad-claude", expires_in: 3599 }), { status: 200 });
      }
      return realFetch(url, init);
    });
    handler = textReply;
    await chatCompletionRound(claude({ azureAuth: "entra", apiToken: "", tenantId: "t", clientId: "c", clientSecret: "s" }), [{ role: "user", content: "hi" }], []);
    expect(tokenCalls).toEqual(["https://ai.azure.com/.default"]);
    expect(seen[0].headers.authorization).toBe("Bearer aad-claude");
    expect(seen[0].headers["x-api-key"]).toBeUndefined();
  });

  it("words 401 and 404 like the other Azure shapes, without retrying them", async () => {
    handler = (_req, _b, res) => apiError(res, 401, "authentication_error", "invalid x-api-key");
    await expect(chatCompletionRound(claude(), [{ role: "user", content: "hi" }], [])).rejects.toThrow(/refused the API key/);
    expect(seen).toHaveLength(1);
    seen.length = 0;
    handler = (_req, _b, res) => apiError(res, 404, "not_found_error", "Deployment not found");
    await expect(chatCompletionRound(claude({ model: "nope" }), [{ role: "user", content: "hi" }], [])).rejects.toThrow(/Deployment "nope" was not found.*Claude Messages API/);
    expect(seen).toHaveLength(1);
  });

  it("Stop surfaces as an AbortError", async () => {
    handler = (_req, _b, res) => { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write(`event: message_start\ndata: ${JSON.stringify(start)}\n\n`); };
    const ac = new AbortController();
    const p = chatCompletionRound(claude(), [{ role: "user", content: "hi" }], [], { signal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });

  it("a stream that goes quiet past the idle timeout fails with 504", async () => {
    handler = (_req, _b, res) => { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write(`event: message_start\ndata: ${JSON.stringify(start)}\n\n`); };
    await expect(chatCompletionRound(claude({ requestTimeoutMs: 300 }), [{ role: "user", content: "hi" }], [])).rejects.toMatchObject({ httpStatus: 504 });
  });

  it("Test Connection answers through the same path", async () => {
    handler = textReply;
    const r = await testConnection(claude());
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/deployment "claude-haiku-5-5" answered \(Claude Messages API, API key\)/);
  });
});
