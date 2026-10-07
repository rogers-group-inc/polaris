/**
 * tests/unit/llmService.test.ts
 *
 * The OpenAI-compatible transport behind the AI assistant (business rule 95),
 * driven against a real local HTTP server so the SSE parsing is exercised the
 * way a model server actually sends it: text in many small deltas, a tool
 * call whose name and JSON arguments arrive in separate fragments, CRLF line
 * endings, a server that ignores stream:true and answers with one JSON body,
 * and Test Connection's model check.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  applyStreamChunk,
  chatCompletionRound,
  normalizeBasePath,
  testConnection,
  listModels,
  looksLikeEmbeddingModel,
  matchModelId,
  pickDefaultModel,
  probeToolCalling,
  resolveChatModel,
  recoverTextToolCalls,
  estimateTokens,
  _clearResolvedModelCache,
  type LlmConfig,
  type ChatToolCall,
} from "../../src/services/llmService.js";

type Handler = (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void;
let handler: Handler = () => {};
let server: http.Server;
let port = 0;
let lastBody: any = null;
let lastAuth: string | undefined;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      lastAuth = req.headers.authorization;
      try { lastBody = body ? JSON.parse(body) : null; } catch { lastBody = body; }
      handler(req, body, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

const cfg = (over: Partial<LlmConfig> = {}): LlmConfig => ({ host: "127.0.0.1", port, model: "qwen2.5:7b", basePath: "/v1", ...over });

function sse(res: http.ServerResponse, chunks: unknown[], eol = "\n") {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}${eol}${eol}`);
  res.write(`data: [DONE]${eol}${eol}`);
  res.end();
}

describe("normalizeBasePath", () => {
  it.each([
    [undefined, "/v1"], ["/v1/", "/v1"], ["v1", "/v1"], ["/", ""], ["", ""], [" /api ", "/api"],
  ])("%s → %s", (input, out) => expect(normalizeBasePath(input as string | undefined)).toBe(out));
});

describe("recoverTextToolCalls", () => {
  const known = ["list_assets", "fleet_summary"];

  it("recovers the fenced shapes qwen2.5 wrote live (name / function keys)", () => {
    const a = 'To find out, we can use the `fleet_summary` tool. Here is the call:\n\n```json\n{\n  "name": "fleet_summary",\n  "arguments": {}\n}\n```';
    expect(recoverTextToolCalls(a, known).map((c) => c.function)).toEqual([{ name: "fleet_summary", arguments: "{}" }]);
    const b = 'Here\'s the tool call:\n```\n{\n  "function": "list_assets",\n  "arguments": {\n    "limit": 1000\n  }\n}\n```';
    expect(recoverTextToolCalls(b, known).map((c) => c.function)).toEqual([{ name: "list_assets", arguments: '{"limit":1000}' }]);
  });

  it("recovers Hermes / Qwen <tool_call> tags and OpenAI-shaped function objects", () => {
    const t = '<tool_call>\n{"name": "list_assets", "arguments": {"monitorStatus": "down"}}\n</tool_call>';
    expect(recoverTextToolCalls(t, known)[0].function).toEqual({ name: "list_assets", arguments: '{"monitorStatus":"down"}' });
    const o = '{"tool_calls":[{"type":"function","function":{"name":"fleet_summary","arguments":"{}"}}]}';
    expect(recoverTextToolCalls(o, known)[0].function).toEqual({ name: "fleet_summary", arguments: "{}" });
  });

  it("leaves ordinary JSON and unknown tool names alone", () => {
    expect(recoverTextToolCalls('Set it like this: {"name": "polaris", "port": 3000}', known)).toEqual([]);
    expect(recoverTextToolCalls('{"name": "delete_everything", "arguments": {}}', known)).toEqual([]);
    expect(recoverTextToolCalls("No JSON here { at all", known)).toEqual([]);
  });

  it("copes with braces inside strings", () => {
    const t = '{"name":"list_assets","arguments":{"search":"a}b{c"}}';
    expect(recoverTextToolCalls(t, known)[0].function.arguments).toBe('{"search":"a}b{c"}');
  });
});

describe("applyStreamChunk", () => {
  it("joins a tool call split across fragments, by index", () => {
    const round = { content: "", toolCalls: new Map<number, ChatToolCall>(), finishReason: null as string | null };
    applyStreamChunk(round, { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "list_", arguments: "" } }] } }] });
    applyStreamChunk(round, { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "assets", arguments: '{"monitor' } }] } }] });
    applyStreamChunk(round, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'Status":"down"}' } }] }, finish_reason: "tool_calls" }] });
    const tc = round.toolCalls.get(0)!;
    expect(tc).toMatchObject({ id: "c1", function: { name: "list_assets", arguments: '{"monitorStatus":"down"}' } });
    expect(round.finishReason).toBe("tool_calls");
  });

  it("accepts object-shaped arguments (Ollama's native form leaking through)", () => {
    const round = { content: "", toolCalls: new Map<number, ChatToolCall>(), finishReason: null as string | null };
    applyStreamChunk(round, { choices: [{ message: { tool_calls: [{ function: { name: "search", arguments: { query: "fw1" } } }] } }] });
    expect(round.toolCalls.get(0)!.function.arguments).toBe('{"query":"fw1"}');
  });

  it("counts reasoning from either field without adding it to the answer", () => {
    const round = { content: "", toolCalls: new Map<number, ChatToolCall>(), finishReason: null as string | null, reasoningChars: 0 };
    expect(applyStreamChunk(round, { choices: [{ delta: { reasoning: "Let me think" } }] })).toBe("");
    applyStreamChunk(round, { choices: [{ delta: { reasoning_content: "abc" } }] });
    applyStreamChunk(round, { choices: [{ delta: { content: "Hi" } }] });
    expect(round.reasoningChars).toBe(15);
    expect(round.content).toBe("Hi");
  });
});

describe("chatCompletionRound", () => {
  it("streams text deltas in order and sends the model, tools and bearer key", async () => {
    handler = (_req, _b, res) => sse(res, [
      { choices: [{ delta: { content: "Two " } }] },
      { choices: [{ delta: { content: "devices are down." } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]);
    const seen: string[] = [];
    const r = await chatCompletionRound(cfg({ apiToken: "sk-local" }), [{ role: "user", content: "hi" }],
      [{ type: "function", function: { name: "search", description: "d", parameters: { type: "object" } } }],
      { onText: (t) => seen.push(t) });
    expect(seen).toEqual(["Two ", "devices are down."]);
    expect(r).toMatchObject({ content: "Two devices are down.", toolCalls: [], finishReason: "stop" });
    expect(lastBody).toMatchObject({ model: "qwen2.5:7b", stream: true, tool_choice: "auto" });
    expect(lastBody.tools).toHaveLength(1);
    expect(lastAuth).toBe("Bearer sk-local");
  });

  it("returns a fragmented tool call whole, with CRLF framing", async () => {
    handler = (_req, _b, res) => sse(res, [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_9", function: { name: "list_alerts", arguments: '{"hou' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'rs":24}' } }] }, finish_reason: "tool_calls" }] },
    ], "\r\n");
    const r = await chatCompletionRound(cfg(), [{ role: "user", content: "alerts?" }], []);
    expect(r.toolCalls).toEqual([{ id: "call_9", type: "function", function: { name: "list_alerts", arguments: '{"hours":24}' } }]);
  });

  it("omits tools entirely on a no-tools round", async () => {
    handler = (_req, _b, res) => sse(res, [{ choices: [{ delta: { content: "ok" } }] }]);
    await chatCompletionRound(cfg(), [{ role: "user", content: "x" }], []);
    expect(lastBody.tools).toBeUndefined();
    expect(lastBody.tool_choice).toBeUndefined();
  });

  it("handles a server that ignores stream:true and sends one JSON body", async () => {
    handler = (_req, _b, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "Whole answer." }, finish_reason: "stop" }] }));
    };
    const seen: string[] = [];
    const r = await chatCompletionRound(cfg(), [{ role: "user", content: "x" }], [], { onText: (t) => seen.push(t) });
    expect(seen).toEqual(["Whole answer."]);
    expect(r.content).toBe("Whole answer.");
  });

  it("turns an auth refusal into a readable error", async () => {
    handler = (_req, _b, res) => { res.writeHead(401, { "Content-Type": "application/json" }); res.end('{"error":"bad key"}'); };
    await expect(chatCompletionRound(cfg(), [{ role: "user", content: "x" }], [])).rejects.toThrow(/refused the API key/);
  });

  it("reports reasoning progress while a thinking model works, and never as text", async () => {
    handler = (_req, _b, res) => sse(res, [
      { choices: [{ delta: { reasoning: "The user wants " } }] },
      { choices: [{ delta: { reasoning: "the down list." } }] },
      { choices: [{ delta: { content: "Two are down." } }] },
    ]);
    const progress: number[] = [];
    const text: string[] = [];
    const r = await chatCompletionRound(cfg(), [{ role: "user", content: "x" }], [],
      { onText: (t) => text.push(t), onReasoning: (n) => progress.push(n) });
    expect(progress).toEqual([15, 29]);
    expect(text).toEqual(["Two are down."]);
    expect(r.content).toBe("Two are down.");
  });

  it("can be aborted mid-stream", async () => {
    handler = (_req, _b, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }] })}\n\n`);
      // never ends
    };
    const ac = new AbortController();
    const p = chatCompletionRound(cfg(), [{ role: "user", content: "x" }], [], { signal: ac.signal, onText: () => ac.abort() });
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });
});

// ─── Model discovery ─────────────────────────────────────────────────────────

/** A fake that is either a plain OpenAI-compatible server or an Ollama. */
function modelServer(opts: { ids: string[]; ollama?: Record<string, string[] | null> }): Handler {
  return (req, body, res) => {
    const json = (status: number, o: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.url === "/v1/models") return json(200, { data: opts.ids.map((id) => ({ id })) });
    if (opts.ollama && req.url === "/api/tags") return json(200, { models: opts.ids.map((name) => ({ name })) });
    if (opts.ollama && req.url === "/api/show") {
      const caps = opts.ollama[JSON.parse(body).model];
      return json(200, caps ? { capabilities: caps } : {});
    }
    json(404, { error: "not found" });
  };
}

describe("listModels", () => {
  it("reads tool-calling support from Ollama's capabilities and drops embedding models", async () => {
    handler = modelServer({
      ids: ["llama2:7b", "nomic-embed-text:latest", "qwen3:8b"],
      ollama: { "llama2:7b": ["completion"], "nomic-embed-text:latest": ["embedding"], "qwen3:8b": ["completion", "tools", "thinking"] },
    });
    const models = await listModels(cfg());
    expect(models).toEqual([
      { id: "qwen3:8b", toolCalling: "yes", toolCallingSource: "ollama", embedding: false },
      { id: "llama2:7b", toolCalling: "no", toolCallingSource: "ollama", embedding: false },
    ]);
  });

  it("reports unknown (never a guess) on a server that is not Ollama, in the server's order", async () => {
    handler = modelServer({ ids: ["model-b", "text-embedding-3-small", "model-a"] });
    const models = await listModels(cfg());
    expect(models.map((m) => [m.id, m.toolCalling, m.toolCallingSource])).toEqual([
      ["model-b", "unknown", null],
      ["model-a", "unknown", null],
    ]);
  });

  it("does not ask the Ollama API behind a non-/v1 path (Open WebUI also answers /api/…)", async () => {
    const seen: string[] = [];
    handler = (req, b, res) => { seen.push(req.url!); modelServer({ ids: ["x"], ollama: { x: ["tools"] } })(req, b, res); };
    await listModels(cfg({ basePath: "/api" })).catch(() => {});
    expect(seen).not.toContain("/api/tags");
  });

  it("keeps the embedding models when they are all the server has", async () => {
    handler = modelServer({ ids: ["bge-m3"] });
    expect((await listModels(cfg())).map((m) => m.id)).toEqual(["bge-m3"]);
  });
});

describe("model helpers", () => {
  it("recognizes common embedding / rerank names but not chat models", () => {
    for (const n of ["nomic-embed-text", "mxbai-embed-large", "bge-m3", "text-embedding-3-small", "jina-reranker-v2", "all-minilm"]) {
      expect(looksLikeEmbeddingModel(n)).toBe(true);
    }
    for (const n of ["qwen3:8b", "llama3.1:70b", "mistral-small", "gemma2", "phi4"]) {
      expect(looksLikeEmbeddingModel(n)).toBe(false);
    }
  });

  it("matches Ollama's bare and :latest names", () => {
    expect(matchModelId(["llama3.1:latest", "qwen3:8b"], "llama3.1")).toBe("llama3.1:latest");
    expect(matchModelId(["qwen3:8b"], "qwen3:8b")).toBe("qwen3:8b");
    expect(matchModelId(["qwen3:8b"], "gpt-4")).toBeNull();
  });

  it("defaults to a tool-calling model, then any chat model", () => {
    expect(pickDefaultModel([
      { id: "a", toolCalling: "no", toolCallingSource: "ollama", embedding: false },
      { id: "b", toolCalling: "yes", toolCallingSource: "ollama", embedding: false },
    ])).toBe("b");
    expect(pickDefaultModel([{ id: "e", toolCalling: "unknown", toolCallingSource: null, embedding: true }])).toBeNull();
  });
});

describe("testConnection", () => {
  it("passes when the configured model is listed (Ollama :latest form included) and returns the list", async () => {
    handler = modelServer({ ids: ["llama3.1:latest", "qwen2.5:7b"] });
    const r = await testConnection(cfg());
    expect(r.ok).toBe(true);
    expect(r.model).toBe("qwen2.5:7b");
    expect(r.models?.map((m) => m.id)).toEqual(["llama3.1:latest", "qwen2.5:7b"]);
    expect((await testConnection(cfg({ model: "llama3.1" }))).model).toBe("llama3.1:latest");
  });

  it("with Model blank, names the model the assistant will use", async () => {
    handler = modelServer({ ids: ["llama2", "qwen3:8b"], ollama: { llama2: ["completion"], "qwen3:8b": ["completion", "tools"] } });
    const r = await testConnection(cfg({ model: "" }));
    expect(r.ok).toBe(true);
    expect(r.model).toBe("qwen3:8b");
    expect(r.message).toMatch(/will use "qwen3:8b" \(supports tool calling\)/);
  });

  it("says so plainly when the chosen model cannot call tools", async () => {
    handler = modelServer({ ids: ["llama2"], ollama: { llama2: ["completion"] } });
    expect((await testConnection(cfg({ model: "llama2" }))).message).toMatch(/does NOT support tool calling/);
  });

  it("fails naming what IS available when the model is missing", async () => {
    handler = modelServer({ ids: ["mistral"] });
    const r = await testConnection(cfg({ model: "gpt-4" }));
    expect(r.ok).toBe(false);
    expect(r.message).toContain("mistral");
  });

  it("fails clearly when the path is not an OpenAI-compatible API", async () => {
    handler = (_req, _b, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end("<html>"); };
    expect((await testConnection(cfg())).message).toMatch(/OpenAI-compatible/);
  });

  it("requires a host", async () => {
    expect((await testConnection({ host: "", model: "x" })).ok).toBe(false);
  });

  it("warns about a small context window, and only then", async () => {
    handler = modelServer({ ids: ["qwen2.5:7b"] });
    expect((await testConnection(cfg({ contextWindow: 4096 }))).message).toMatch(/Context window is 4096 tokens.*OLLAMA_CONTEXT_LENGTH/);
    expect((await testConnection(cfg({ contextWindow: 8192 }))).message).not.toMatch(/Context window/);
    expect((await testConnection(cfg())).message).not.toMatch(/Context window/);
  });
});

describe("estimateTokens", () => {
  it("counts about 3.5 characters a token, rounding up", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abc")).toBe(1);
    expect(estimateTokens("x".repeat(35))).toBe(10);
  });
});

describe("probeToolCalling", () => {
  it("is yes when the model calls the dummy tool", async () => {
    handler = (_req, _b, res) => sse(res, [{ choices: [{ delta: { tool_calls: [{ index: 0, id: "p", function: { name: "polaris_probe", arguments: '{"ok":true}' } }] }, finish_reason: "tool_calls" }] }]);
    expect(await probeToolCalling(cfg(), "qwen3:8b")).toBe("yes");
    expect(lastBody).toMatchObject({ model: "qwen3:8b", temperature: 0 });
    expect(lastBody.tools[0].function.name).toBe("polaris_probe");
  });

  it("is no when the model answers in prose", async () => {
    handler = (_req, _b, res) => sse(res, [{ choices: [{ delta: { content: "ok=true" }, finish_reason: "stop" }] }]);
    expect(await probeToolCalling(cfg(), "llama2")).toBe("no");
  });

  it("is no when the server rejects tools for the model", async () => {
    handler = (_req, _b, res) => { res.writeHead(400, { "Content-Type": "application/json" }); res.end('{"error":{"message":"registry.ollama.ai/library/llama2 does not support tools"}}'); };
    expect(await probeToolCalling(cfg(), "llama2")).toBe("no");
  });

  it("throws on a connection failure rather than answering about the model", async () => {
    await expect(probeToolCalling(cfg({ port: 1 }), "x")).rejects.toThrow();
  });
});

describe("resolveChatModel", () => {
  it("uses the configured model as-is, and picks + caches when blank", async () => {
    _clearResolvedModelCache();
    expect(await resolveChatModel("i1", cfg({ model: "set-one" }))).toBe("set-one");
    let calls = 0;
    handler = (req, b, res) => { if (req.url === "/v1/models") calls++; modelServer({ ids: ["m1", "m2"] })(req, b, res); };
    expect(await resolveChatModel("i2", cfg({ model: "" }))).toBe("m1");
    expect(await resolveChatModel("i2", cfg({ model: "" }))).toBe("m1");
    expect(calls).toBe(1);
  });
});

