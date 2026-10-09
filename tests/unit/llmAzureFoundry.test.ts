/**
 * tests/unit/llmAzureFoundry.test.ts
 *
 * The Azure AI Foundry provider of the `llm` integration (business rule
 * 95(j)): request paths per API shape, endpoint parsing, the three auth-header
 * cases, the Entra client-credentials token cache, the temperature retry for
 * reasoning deployments, Azure's empty-choices first chunk, provider-aware
 * error wording, and Test Connection by one chat round. Driven against a local
 * HTTP server standing in for Foundry, with `fetch` stubbed for Entra — no
 * test ever reaches Azure.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  AZURE_DEFAULTS,
  applyStreamChunk,
  azureChatPath,
  chatCompletionRound,
  chatCompletionsPath,
  describeEndpoint,
  getAzureEntraToken,
  listModels,
  llmAuthHeaders,
  parseAzureEndpoint,
  probeToolCalling,
  resolveChatModel,
  testConnection,
  upstreamError,
  _clearEntraTokenCache,
  _clearTemperatureRefusals,
  type ChatToolCall,
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

afterAll(() => new Promise<void>((r) => server.close(() => r())));

beforeEach(() => {
  seen.length = 0;
  _clearEntraTokenCache();
  _clearTemperatureRefusals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const azure = (over: Partial<LlmConfig> = {}): LlmConfig => ({
  provider: "azure",
  host: "127.0.0.1",
  port,
  useHttps: false,
  basePath: "",
  model: "gpt-4o-prod",
  apiToken: "azure-key-1",
  ...over,
});

const entra = (over: Partial<LlmConfig> = {}): LlmConfig => azure({
  apiToken: "",
  azureAuth: "entra",
  tenantId: "contoso.onmicrosoft.com",
  clientId: "11111111-2222-3333-4444-555555555555",
  clientSecret: "s3cret",
  ...over,
});

function sse(res: http.ServerResponse, chunks: unknown[]) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

function fail(res: http.ServerResponse, status: number, message: string) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { code: String(status), message } }));
}

const okReply: Handler = (_req, _b, res) => sse(res, [
  // Azure's first chunk can carry only the prompt filter verdict, no choices.
  { choices: [], prompt_filter_results: [{ prompt_index: 0, content_filter_results: {} }] },
  { choices: [{ index: 0, delta: { content: "OK" } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
]);

/** A fetch stub answering the Entra token endpoint. */
function stubEntra(answer: () => { status: number; body: unknown }) {
  const fn = vi.fn(async (_url: string, _init?: RequestInit) => {
    const a = answer();
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

// ─── Pure helpers ────────────────────────────────────────────────────────────

describe("parseAzureEndpoint", () => {
  it.each([
    ["https://res.openai.azure.com/", { host: "res.openai.azure.com", port: 443, useHttps: true, basePath: "" }],
    ["https://res.services.ai.azure.com/openai/v1", { host: "res.services.ai.azure.com", port: 443, useHttps: true, basePath: "" }],
    ["https://res.openai.azure.com/openai/deployments/x/chat/completions?api-version=2024-10-21", { host: "res.openai.azure.com", port: 443, useHttps: true, basePath: "" }],
    ["res.openai.azure.com", { host: "res.openai.azure.com", port: 443, useHttps: true, basePath: "" }],
    ["https://apim.example.com:8443/aoai/openai/v1/", { host: "apim.example.com", port: 8443, useHttps: true, basePath: "/aoai" }],
    ["http://10.0.0.5", { host: "10.0.0.5", port: 80, useHttps: false, basePath: "" }],
    ["https://[2001:db8::1]/", { host: "2001:db8::1", port: 443, useHttps: true, basePath: "" }],
  ])("%s", (input, out) => expect(parseAzureEndpoint(input)).toEqual(out));

  it("refuses text that is not a host or URL", () => {
    expect(parseAzureEndpoint("")).toBeNull();
    expect(parseAzureEndpoint("ftp://res.openai.azure.com")).toBeNull();
    expect(parseAzureEndpoint("https://")).toBeNull();
  });
});

describe("chat paths", () => {
  it("v1 is the default shape and needs no api-version", () => {
    expect(azureChatPath(azure())).toBe("/openai/v1/chat/completions");
    expect(chatCompletionsPath(azure({ azureApiShape: "v1", azureApiVersion: "2024-10-21" }))).toBe("/openai/v1/chat/completions");
  });

  it("the deployments shape encodes the deployment name and carries the api-version", () => {
    expect(azureChatPath(azure({ azureApiShape: "deployments", model: "gpt 4o/eu", azureApiVersion: "2025-04-01-preview" })))
      .toBe("/openai/deployments/gpt%204o%2Feu/chat/completions?api-version=2025-04-01-preview");
    expect(azureChatPath(azure({ azureApiShape: "deployments", azureApiVersion: "" })))
      .toBe(`/openai/deployments/gpt-4o-prod/chat/completions?api-version=${AZURE_DEFAULTS.apiVersion}`);
  });

  it("a gateway prefix is kept; Azure never gets the OpenAI default /v1 prefix", () => {
    expect(chatCompletionsPath(azure({ basePath: "/aoai/" }))).toBe("/aoai/openai/v1/chat/completions");
    expect(chatCompletionsPath(azure({ basePath: undefined }))).toBe("/openai/v1/chat/completions");
    expect(describeEndpoint(azure({ host: "res.openai.azure.com", port: 443, useHttps: true, basePath: undefined }))).toBe("https://res.openai.azure.com:443");
  });

  it("an OpenAI-compatible config keeps its own path and /v1 default", () => {
    expect(chatCompletionsPath({ host: "h", model: "m" })).toBe("/v1/chat/completions");
    expect(chatCompletionsPath({ host: "h", model: "m", provider: "openai", basePath: "/api" })).toBe("/api/chat/completions");
  });
});

describe("llmAuthHeaders", () => {
  it("OpenAI-compatible: Bearer when a key is set, nothing otherwise", () => {
    expect(llmAuthHeaders({ host: "h", model: "m", apiToken: "k" })).toEqual({ Authorization: "Bearer k" });
    expect(llmAuthHeaders({ host: "h", model: "m" })).toEqual({});
  });

  it("Azure key: the api-key header, never a Bearer", () => {
    expect(llmAuthHeaders(azure())).toEqual({ "api-key": "azure-key-1" });
  });

  it("Azure Entra: the access token as a Bearer, and never the stored API key", () => {
    expect(llmAuthHeaders(entra({ apiToken: "left-over-key" }), "tok")).toEqual({ Authorization: "Bearer tok" });
  });
});

describe("applyStreamChunk with Azure's filter-only chunk", () => {
  it("tolerates choices: [] and keeps the round untouched", () => {
    const round = { content: "", toolCalls: new Map<number, ChatToolCall>(), finishReason: null as string | null };
    expect(applyStreamChunk(round, { choices: [], prompt_filter_results: [{ prompt_index: 0 }] })).toBe("");
    expect(applyStreamChunk(round, { prompt_filter_results: [] })).toBe("");
    expect(round).toEqual({ content: "", toolCalls: new Map(), finishReason: null });
  });
});

describe("upstreamError wording", () => {
  it("names the auth mode on 401 / 403 and the deployment on 404", () => {
    expect(upstreamError(401, "{}", azure()).message).toMatch(/refused the API key/);
    expect(upstreamError(401, "{}", entra()).message).toMatch(/refused the Entra ID token.*cognitiveservices/);
    expect(upstreamError(403, "{}", entra()).message).toMatch(/Cognitive Services OpenAI User/);
    expect(upstreamError(404, "{}", azure()).message).toMatch(/Deployment "gpt-4o-prod" was not found.*DEPLOYMENT name/);
  });

  it("leaves the OpenAI-compatible wording alone", () => {
    expect(upstreamError(401, "{}").message).toBe("The LLM server refused the API key (HTTP 401)");
    expect(upstreamError(401, "{}", { host: "h", model: "m" }).message).toBe("The LLM server refused the API key (HTTP 401)");
  });
});

// ─── Transport ───────────────────────────────────────────────────────────────

describe("chatCompletionRound on Azure", () => {
  it("posts to the v1 path with api-key and the deployment as model", async () => {
    handler = okReply;
    const round = await chatCompletionRound(azure(), [{ role: "user", content: "hi" }], []);
    expect(round.content).toBe("OK");
    expect(round.finishReason).toBe("stop");
    expect(seen[0].url).toBe("/openai/v1/chat/completions");
    expect(seen[0].headers["api-key"]).toBe("azure-key-1");
    expect(seen[0].headers.authorization).toBeUndefined();
    expect(seen[0].body).toMatchObject({ model: "gpt-4o-prod", stream: true, temperature: 0.2 });
    expect(seen[0].body).not.toHaveProperty("max_tokens");
  });

  it("posts to the legacy deployments path with its api-version", async () => {
    handler = okReply;
    await chatCompletionRound(azure({ azureApiShape: "deployments", azureApiVersion: "2024-10-21" }), [{ role: "user", content: "hi" }], []);
    expect(seen[0].url).toBe("/openai/deployments/gpt-4o-prod/chat/completions?api-version=2024-10-21");
  });

  it("omitTemperature never sends temperature", async () => {
    handler = okReply;
    await chatCompletionRound(azure({ omitTemperature: true }), [{ role: "user", content: "hi" }], []);
    expect(seen[0].body).not.toHaveProperty("temperature");
  });

  it("retries once without temperature on a 400 naming it, and remembers the refusal", async () => {
    handler = (_req, body, res) => {
      if (body && "temperature" in body) fail(res, 400, "Unsupported parameter: 'temperature' is not supported with this model.");
      else okReply(_req, body, res);
    };
    const r = await chatCompletionRound(azure({ model: "o4-mini" }), [{ role: "user", content: "hi" }], []);
    expect(r.content).toBe("OK");
    expect(seen.map((s) => "temperature" in s.body)).toEqual([true, false]);
    // The next round for this deployment skips the doomed first attempt.
    await chatCompletionRound(azure({ model: "o4-mini" }), [{ role: "user", content: "again" }], []);
    expect(seen).toHaveLength(3);
    expect(seen[2].body).not.toHaveProperty("temperature");
  });

  it("a 400 about something else is not retried", async () => {
    handler = (_req, _b, res) => fail(res, 400, "Invalid value for 'tool_choice'");
    await expect(chatCompletionRound(azure(), [{ role: "user", content: "hi" }], [])).rejects.toThrow(/Azure AI Foundry error \(HTTP 400\)/);
    expect(seen).toHaveLength(1);
  });

  it("an OpenAI-compatible server is never retried without temperature", async () => {
    handler = (_req, _b, res) => fail(res, 400, "temperature out of range");
    await expect(chatCompletionRound({ host: "127.0.0.1", port, model: "m" }, [{ role: "user", content: "hi" }], [])).rejects.toThrow(/LLM server error \(HTTP 400\)/);
    expect(seen).toHaveLength(1);
  });

  it("tool calling goes through unchanged (probeToolCalling)", async () => {
    handler = (_req, _b, res) => sse(res, [
      { choices: [], prompt_filter_results: [] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "polaris_probe", arguments: "" } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"ok":true}' } }] }, finish_reason: "tool_calls" }] },
    ]);
    expect(await probeToolCalling(azure(), "gpt-4o-prod")).toBe("yes");
    expect(seen[0].body.tools[0].function.name).toBe("polaris_probe");
  });
});

describe("Entra ID token", () => {
  const tokenOk = () => ({ status: 200, body: { token_type: "Bearer", access_token: "aad-token-1", expires_in: 3599 } });

  it("asks login.microsoftonline.com for the cognitive services scope and sends the token as Bearer", async () => {
    const fetchFn = stubEntra(tokenOk);
    handler = okReply;
    await chatCompletionRound(entra(), [{ role: "user", content: "hi" }], []);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/token");
    const form = new URLSearchParams(String(init?.body));
    expect(form.get("grant_type")).toBe("client_credentials");
    expect(form.get("scope")).toBe("https://cognitiveservices.azure.com/.default");
    expect(seen[0].headers.authorization).toBe("Bearer aad-token-1");
    expect(seen[0].headers["api-key"]).toBeUndefined();
  });

  it("caches the token, shares one in-flight fetch, and re-fetches for a rotated secret or another scope", async () => {
    const fetchFn = stubEntra(tokenOk);
    const [a, b] = await Promise.all([getAzureEntraToken(entra()), getAzureEntraToken(entra())]);
    expect(a).toBe("aad-token-1");
    expect(b).toBe("aad-token-1");
    await getAzureEntraToken(entra());
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await getAzureEntraToken(entra({ clientSecret: "rotated" }));
    await getAzureEntraToken(entra({ azureScope: "https://ai.azure.com/.default" }));
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("refreshes a token inside its last 5 minutes", async () => {
    const fetchFn = stubEntra(() => ({ status: 200, body: { access_token: "short", expires_in: 240 } }));
    await getAzureEntraToken(entra());
    await getAzureEntraToken(entra());
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("never caches a failure, and reports the AADSTS reason without the secret", async () => {
    let n = 0;
    const fetchFn = stubEntra(() => (n++ === 0
      ? { status: 401, body: { error: "invalid_client", error_description: "AADSTS7000215: Invalid client secret provided.\r\nTrace ID: x" } }
      : tokenOk()));
    const err = await getAzureEntraToken(entra()).catch((e) => e);
    expect(err.message).toBe("Entra ID refused the token request (HTTP 401): AADSTS7000215: Invalid client secret provided.");
    expect(err.message).not.toContain("s3cret");
    expect(await getAzureEntraToken(entra())).toBe("aad-token-1");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("refuses without tenant / client / secret, before any request", async () => {
    const fetchFn = stubEntra(tokenOk);
    await expect(getAzureEntraToken(entra({ clientSecret: "" }))).rejects.toThrow(/tenant ID, client ID and client secret/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("drops a cached token the data plane answers 401 to", async () => {
    let n = 0;
    const fetchFn = stubEntra(() => ({ status: 200, body: { access_token: `aad-${++n}`, expires_in: 3599 } }));
    handler = (_req, _b, res) => fail(res, 401, "Access denied due to invalid subscription key or wrong API endpoint.");
    await expect(chatCompletionRound(entra(), [{ role: "user", content: "hi" }], [])).rejects.toThrow(/refused the Entra ID token/);
    handler = okReply;
    await chatCompletionRound(entra(), [{ role: "user", content: "hi" }], []);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(seen[1].headers.authorization).toBe("Bearer aad-2");
  });
});

describe("model discovery and Test Connection on Azure", () => {
  it("listModels refuses — Foundry has no deployment list — and asks for nothing", async () => {
    await expect(listModels(azure())).rejects.toThrow(/cannot list deployments/);
    expect(seen).toHaveLength(0);
  });

  it("resolveChatModel uses the deployment, and refuses a blank one", async () => {
    expect(await resolveChatModel("i1", azure())).toBe("gpt-4o-prod");
    await expect(resolveChatModel("i2", azure({ model: "" }))).rejects.toThrow(/deployment name/);
  });

  it("Test Connection sends one tiny chat round with no tools", async () => {
    handler = okReply;
    const r = await testConnection(azure());
    expect(r.ok).toBe(true);
    expect(r.model).toBe("gpt-4o-prod");
    expect(r.message).toMatch(/deployment "gpt-4o-prod" answered \(v1 API, API key\)/);
    expect(seen).toHaveLength(1);
    expect(seen[0].body).not.toHaveProperty("tools");
  });

  it("Test Connection names a missing deployment and a refused key", async () => {
    handler = (_req, _b, res) => fail(res, 404, "The API deployment for this resource does not exist.");
    expect((await testConnection(azure({ model: "nope" }))).message).toMatch(/Deployment "nope" was not found/);
    handler = (_req, _b, res) => fail(res, 401, "Access denied");
    expect(await testConnection(azure())).toMatchObject({ ok: false, message: expect.stringMatching(/refused the API key/) });
  });

  it("Test Connection with Entra reports the token failure itself", async () => {
    stubEntra(() => ({ status: 400, body: { error: "invalid_request", error_description: "AADSTS90002: Tenant 'contoso.onmicrosoft.com' not found." } }));
    const r = await testConnection(entra());
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/AADSTS90002/);
    expect(seen).toHaveLength(0);
  });

  it("Test Connection without a deployment fails before any request", async () => {
    expect(await testConnection(azure({ model: " " }))).toMatchObject({ ok: false, message: expect.stringMatching(/deployment name/) });
    expect(seen).toHaveLength(0);
  });
});
