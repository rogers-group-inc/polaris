/**
 * src/services/llmService.ts — the `llm` integration's transport: an
 * OpenAI-compatible chat-completions client (business rule 95).
 *
 * Speaks `POST {base}/chat/completions` with `stream: true` and `tools`, and
 * `GET {base}/models` for Test Connection. That one dialect covers Ollama,
 * LM Studio, vLLM, the llama.cpp server, LocalAI and Open WebUI, so the
 * integration is "any OpenAI-compatible endpoint" rather than one product.
 *
 * Built on node:http / node:https rather than fetch so `verifySsl: false`
 * works against a self-signed lab server without pulling in undici — the same
 * transport choice as vcenterService / fortigateService.
 *
 * Streaming: the upstream SSE body is parsed incrementally. Text deltas are
 * handed to `onText` as they arrive; tool-call deltas (which arrive in
 * fragments — the function name in one chunk, the JSON arguments spread over
 * many) are accumulated by index and returned whole when the round ends. A
 * server that ignores `stream: true` and answers with one JSON body is
 * handled too: its content is emitted in a single `onText` call.
 */

import http from "node:http";
import https from "node:https";
import { AppError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

export interface LlmConfig {
  host: string;
  port?: number;
  useHttps?: boolean;
  verifySsl?: boolean;
  /** Path prefix of the OpenAI-compatible API, e.g. "/v1" (Ollama, LM Studio, vLLM) or "/api" (Open WebUI). */
  basePath?: string;
  apiToken?: string;
  model: string;
  /** The name the chat window shows for the assistant; blank = "Assistant". */
  displayName?: string;
  temperature?: number;
  maxToolRounds?: number;
  requestTimeoutMs?: number;
  maxRowsPerTool?: number;
  contextMessages?: number;
  /** The model server's context window in tokens (Ollama: OLLAMA_CONTEXT_LENGTH, default 4096). */
  contextWindow?: number;
  systemPromptExtra?: string;
  allowLoopback?: boolean;
  verboseLogging?: boolean;
  // Stamped by llmIntegrationService.provisionLlmAccess — not operator-set.
  roleId?: string;
  roleName?: string;
  tokenId?: string;
}

export const LLM_DEFAULTS = {
  port: 11434,
  basePath: "/v1",
  temperature: 0.2,
  maxToolRounds: 6,
  requestTimeoutMs: 120_000,
  maxRowsPerTool: 200,
  contextMessages: 20,
  contextWindow: 8192,
} as const;

/**
 * Rough token count for budgeting: ~3.5 characters a token for English and
 * JSON under the tokenizers local models use. Deliberately approximate —
 * it only decides what to trim, never what to send verbatim. Exported for tests.
 */
export function estimateTokens(text: string): number {
  return Math.ceil((text ?? "").length / 3.5);
}

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ChatToolDef {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface CompletionRound {
  content: string;
  toolCalls: ChatToolCall[];
  finishReason: string | null;
}

/** Normalize the operator-entered path prefix: leading slash, no trailing slash. */
export function normalizeBasePath(p: string | undefined): string {
  const raw = (p ?? LLM_DEFAULTS.basePath).trim();
  if (!raw || raw === "/") return "";
  const withLead = raw.startsWith("/") ? raw : `/${raw}`;
  return withLead.replace(/\/+$/, "");
}

/** Human-readable endpoint for messages and the integration card. */
export function describeEndpoint(config: LlmConfig): string {
  const scheme = config.useHttps ? "https" : "http";
  const port = config.port ?? LLM_DEFAULTS.port;
  return `${scheme}://${config.host}:${port}${normalizeBasePath(config.basePath)}`;
}

interface RawResponse {
  status: number;
  contentType: string;
  stream: http.IncomingMessage;
}

function openRequest(
  config: LlmConfig,
  method: "GET" | "POST",
  path: string,
  body: unknown,
  signal: AbortSignal | undefined,
): Promise<RawResponse> {
  if (!config.host) return Promise.reject(new AppError(400, "LLM host is required"));
  const mod = config.useHttps ? https : http;
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const headers: Record<string, string> = { Accept: "application/json, text/event-stream" };
  if (payload !== undefined) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = String(Buffer.byteLength(payload));
  }
  if (config.apiToken) headers.Authorization = `Bearer ${config.apiToken}`;
  const timeout = config.requestTimeoutMs ?? LLM_DEFAULTS.requestTimeoutMs;

  return new Promise((resolve, reject) => {
    const req = mod.request(
      {
        host: config.host,
        port: config.port ?? LLM_DEFAULTS.port,
        method,
        path: normalizeBasePath(config.basePath) + path,
        headers,
        signal,
        ...(config.useHttps ? { rejectUnauthorized: config.verifySsl !== false } : {}),
      },
      (res) => resolve({
        status: res.statusCode ?? 0,
        contentType: String(res.headers["content-type"] ?? ""),
        stream: res,
      }),
    );
    // Idle timeout, not a wall-clock cap: a local model on modest hardware can
    // take a while before its first token, then stream for a long time.
    req.setTimeout(timeout, () => req.destroy(new AppError(504, `LLM server did not respond within ${Math.round(timeout / 1000)}s`)));
    req.on("error", (err: any) => {
      if (err?.name === "AbortError") reject(err);
      else if (err instanceof AppError) reject(err);
      else reject(new AppError(502, `Could not reach the LLM server at ${describeEndpoint(config)}: ${err?.message || err}`));
    });
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

async function readAll(stream: http.IncomingMessage, cap = 2_000_000): Promise<string> {
  let out = "";
  for await (const chunk of stream) {
    out += chunk.toString("utf8");
    if (out.length > cap) break;
  }
  return out;
}

function upstreamError(status: number, body: string): AppError {
  let detail = body.trim();
  try {
    const j = JSON.parse(body);
    detail = j?.error?.message ?? j?.error ?? j?.message ?? detail;
  } catch { /* plain-text body */ }
  if (typeof detail !== "string") detail = JSON.stringify(detail);
  if (status === 401 || status === 403) {
    return new AppError(502, `The LLM server refused the API key (HTTP ${status})`);
  }
  return new AppError(502, `LLM server error (HTTP ${status}): ${detail.slice(0, 300)}`);
}

// ─── Model discovery ─────────────────────────────────────────────────────────
//
// GET {base}/models is part of the OpenAI-compatible surface, so every server
// can say WHICH models it has. What it cannot say is whether a model supports
// tool calling — without which the assistant can chat but never look anything
// up. Two sources fill that gap, and anything neither covers is reported as
// "unknown", never guessed:
//   - Ollama's native API (`/api/tags` to recognize it, `/api/show` per model)
//     reports `capabilities` (["completion","tools"], ["embedding"], …) on
//     current versions. Only tried when the OpenAI path is `/v1` or empty,
//     because Open WebUI also answers under `/api/…` with different meanings.
//   - probeToolCalling(): one real chat request offering a dummy tool, run
//     only on the model the operator asks about (it costs a model call).

export type ToolCallingSupport = "yes" | "no" | "unknown";

export interface LlmModelInfo {
  id: string;
  toolCalling: ToolCallingSupport;
  /** Where toolCalling came from: Ollama's capabilities, a probe, or nowhere. */
  toolCallingSource: "ollama" | "probe" | null;
  /** Embedding / rerank models cannot chat; listed only when nothing else is. */
  embedding: boolean;
}

// Name patterns of embedding / rerank models on servers that do not report
// capabilities. Conservative on purpose: a miss only means an extra entry in
// the dropdown, while a false hit would hide a chat model.
const EMBEDDING_NAME = /(^|[\/:_-])(embed|embedding|embeddings|bge|e5|gte|minilm|rerank|reranker)([\/:_.-]|$)|nomic-embed|text-embedding|mxbai-embed|snowflake-arctic-embed/i;

/** Heuristic embedding-model test for servers that report no capabilities. Exported for tests. */
export function looksLikeEmbeddingModel(id: string): boolean {
  return EMBEDDING_NAME.test(id);
}

function parseModelIds(body: string): string[] | null {
  try {
    const j = JSON.parse(body);
    const list = Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : [];
    return list.map((m: any) => String(m?.id ?? m?.name ?? m?.model ?? "")).filter(Boolean);
  } catch {
    return null;
  }
}

async function getJson(config: LlmConfig, method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await openRequest(config, method, path, body, undefined);
  const text = await readAll(res.stream);
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json };
}

/**
 * Ollama capabilities for the given models, or null when this is not an
 * Ollama server (or one too old to report capabilities). Exported for tests.
 */
export async function ollamaCapabilities(config: LlmConfig, ids: string[]): Promise<Map<string, string[]> | null> {
  const base = normalizeBasePath(config.basePath);
  if (base !== "/v1" && base !== "") return null;
  const native: LlmConfig = { ...config, basePath: "", requestTimeoutMs: 10_000 };
  try {
    const tags = await getJson(native, "GET", "/api/tags");
    if (tags.status !== 200 || !Array.isArray(tags.json?.models)) return null;
  } catch {
    return null;
  }
  const out = new Map<string, string[]>();
  // A handful at a time — /api/show reads model metadata off disk.
  const queue = ids.slice(0, 40);
  const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      try {
        const r = await getJson(native, "POST", "/api/show", { model: id });
        if (r.status === 200 && Array.isArray(r.json?.capabilities)) out.set(id, r.json.capabilities.map(String));
      } catch { /* leave unknown */ }
    }
  });
  await Promise.all(workers);
  return out.size ? out : null;
}

/**
 * The server's models, chat-capable ones first and tool-calling ones first
 * among those. Embedding / rerank models are dropped unless they are all the
 * server has. Throws an AppError when the server cannot be reached or does
 * not speak the OpenAI-compatible list.
 */
export async function listModels(config: LlmConfig): Promise<LlmModelInfo[]> {
  if (!config.host) throw new AppError(400, "Host is required");
  const res = await openRequest({ ...config, requestTimeoutMs: Math.min(config.requestTimeoutMs ?? 15_000, 15_000) }, "GET", "/models", undefined, undefined);
  const body = await readAll(res.stream);
  if (res.status < 200 || res.status >= 300) throw upstreamError(res.status, body);
  const ids = parseModelIds(body);
  if (ids === null) {
    throw new AppError(502, `${describeEndpoint(config)}/models did not return JSON — is this an OpenAI-compatible endpoint? Check the API path.`);
  }
  const caps = await ollamaCapabilities(config, ids);
  const models: LlmModelInfo[] = ids.map((id) => {
    const c = caps?.get(id);
    if (c) {
      const embedding = c.includes("embedding") && !c.includes("completion");
      return { id, toolCalling: c.includes("tools") ? "yes" : "no", toolCallingSource: "ollama", embedding };
    }
    return { id, toolCalling: "unknown", toolCallingSource: null, embedding: looksLikeEmbeddingModel(id) };
  });
  const chat = models.filter((m) => !m.embedding);
  const rank = (m: LlmModelInfo) => (m.toolCalling === "yes" ? 0 : m.toolCalling === "unknown" ? 1 : 2);
  // Stable: within a rank, keep the server's own order.
  return (chat.length ? chat : models)
    .map((m, i) => ({ m, i }))
    .sort((a, b) => rank(a.m) - rank(b.m) || a.i - b.i)
    .map(({ m }) => m);
}

/** Does `wanted` name one of `ids`? Ollama's `name` ≡ `name:latest`. Exported for tests. */
export function matchModelId(ids: string[], wanted: string): string | null {
  const w = wanted.trim();
  if (!w) return null;
  return ids.find((id) => id === w) ?? ids.find((id) => id === `${w}:latest` || id.split(":")[0] === w) ?? null;
}

/**
 * The model to use when the integration leaves Model blank: the first
 * tool-calling model, else the first chat model. Null when there is none.
 */
export function pickDefaultModel(models: LlmModelInfo[]): string | null {
  return models.find((m) => !m.embedding && m.toolCalling === "yes")?.id
    ?? models.find((m) => !m.embedding && m.toolCalling !== "no")?.id
    ?? models.find((m) => !m.embedding)?.id
    ?? null;
}

const PROBE_TOOL: ChatToolDef = {
  type: "function",
  function: {
    name: "polaris_probe",
    description: "Connectivity check. Call this tool with ok=true.",
    parameters: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
  },
};

/**
 * Ask the model, once, to call a dummy tool. "yes" when it does; "no" when it
 * answers in prose or the server rejects `tools` outright; throws on a
 * connection failure (that is not an answer about the model). Bounded at 90 s.
 */
export async function probeToolCalling(config: LlmConfig, model: string): Promise<ToolCallingSupport> {
  const signal = AbortSignal.timeout(90_000);
  try {
    const round = await chatCompletionRound(
      { ...config, model, temperature: 0 },
      [
        { role: "system", content: "You are a connectivity check. Always answer by calling the polaris_probe tool." },
        { role: "user", content: "Call polaris_probe with ok=true now." },
      ],
      [PROBE_TOOL],
      { signal },
    );
    return round.toolCalls.some((tc) => tc.function.name === "polaris_probe") ? "yes" : "no";
  } catch (err: any) {
    if (signal.aborted) throw new AppError(504, "The model did not answer the tool-calling check within 90 s");
    // A server that refuses the `tools` field for this model ("does not support tools").
    if (err instanceof AppError && /\btools?\b/i.test(err.message) && /support|not|invalid|unknown/i.test(err.message)) return "no";
    throw err;
  }
}

export interface LlmTestResult {
  ok: boolean;
  message: string;
  version?: string;
  models?: LlmModelInfo[];
  /** The model the assistant will use (the configured one, or the default pick). */
  model?: string | null;
}

/**
 * Test Connection: list the server's models (with tool-calling support where
 * it can be known) and check the configured model is among them. A blank
 * Model passes when the server has a chat model to default to.
 */
/** Below this many tokens a turn has little room left for lookups (assistantChatService.contextBudget). */
export const SMALL_CONTEXT_WINDOW = 6000;

export async function testConnection(config: LlmConfig): Promise<LlmTestResult> {
  const out = await testConnectionInner(config);
  const w = config.contextWindow ?? LLM_DEFAULTS.contextWindow;
  if (out.ok && w < SMALL_CONTEXT_WINDOW) {
    out.message += `. Context window is ${w} tokens — lookup results will be cut short; raise it on the server (Ollama: OLLAMA_CONTEXT_LENGTH) and here if you can`;
  }
  return out;
}

async function testConnectionInner(config: LlmConfig): Promise<LlmTestResult> {
  if (!config.host) return { ok: false, message: "Host is required" };
  let models: LlmModelInfo[];
  try {
    models = await listModels(config);
  } catch (err: any) {
    return { ok: false, message: err instanceof AppError ? err.message : err?.message || "Unknown error" };
  }
  const n = models.length;
  const wanted = (config.model ?? "").trim();
  if (!wanted) {
    const pick = pickDefaultModel(models);
    if (!pick) return { ok: false, message: "Connected, but the server lists no chat model", models, model: null };
    const tc = models.find((m) => m.id === pick)!.toolCalling;
    return {
      ok: true,
      message: `Connected — ${n} model(s). Model is blank, so the assistant will use "${pick}"${tc === "yes" ? " (supports tool calling)" : tc === "no" ? " — which does NOT support tool calling" : ""}.`,
      models,
      model: pick,
    };
  }
  const hit = matchModelId(models.map((m) => m.id), wanted);
  if (!hit) {
    const sample = models.slice(0, 8).map((m) => m.id).join(", ") || "none";
    return { ok: false, message: `Connected, but model "${wanted}" is not on the server. Available: ${sample}`, models, model: null };
  }
  const tc = models.find((m) => m.id === hit)!.toolCalling;
  const note = tc === "yes" ? "supports tool calling"
    : tc === "no" ? "does NOT support tool calling — the assistant can chat but cannot look anything up"
    : "tool calling not verified — use Check tool calling";
  return { ok: true, message: `Connected — "${hit}" is available and ${note} (${n} model(s) on the server)`, models, model: hit };
}

/** The models a test of this config would offer, as a plain list for the form. */
export async function describeModels(config: LlmConfig): Promise<{ models: LlmModelInfo[]; defaultModel: string | null }> {
  const models = await listModels(config);
  return { models, defaultModel: pickDefaultModel(models) };
}

// ─── Resolving a blank Model at chat time ────────────────────────────────────

const resolvedModelCache = new Map<string, { model: string; at: number }>();
const RESOLVE_TTL_MS = 5 * 60_000;

/**
 * The model a chat turn sends: the configured one, or — when Model is blank —
 * the server's default pick, cached per integration for 5 minutes so a turn
 * does not re-list models.
 */
export async function resolveChatModel(integrationId: string, config: LlmConfig): Promise<string> {
  const configured = (config.model ?? "").trim();
  if (configured) return configured;
  const hit = resolvedModelCache.get(integrationId);
  if (hit && Date.now() - hit.at < RESOLVE_TTL_MS) return hit.model;
  const pick = pickDefaultModel(await listModels(config));
  if (!pick) throw new AppError(409, "The LLM server lists no chat model — set Model on the integration");
  resolvedModelCache.set(integrationId, { model: pick, at: Date.now() });
  return pick;
}

/** Test hook. */
export function _clearResolvedModelCache(): void {
  resolvedModelCache.clear();
}

// ─── Tool calls written as text ──────────────────────────────────────────────
//
// Small local models sometimes WRITE a tool call into their reply ("Here's the
// tool call: ```json {"name":"fleet_summary","arguments":{}}```") instead of
// emitting a structured `tool_calls` entry — and once one such reply sits in
// the conversation history, the model copies the pattern every turn after.
// Seen live 2026-10-07 with qwen2.5:7b on Ollama: 6/6 structured calls on a
// fresh conversation, text-only calls once a text-mode reply was in history.
// recoverTextToolCalls() turns such text back into calls, but ONLY for the
// tool names this request actually offered, so ordinary JSON in an answer
// (a config example, a report preview) is never mistaken for one.

function balancedObjectAt(s: string, start: number): string | null {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return s.slice(start, i + 1);
  }
  return null;
}

function asCall(obj: any, known: ReadonlySet<string>): { name: string; arguments: string } | null {
  if (!obj || typeof obj !== "object") return null;
  const fn = obj.function && typeof obj.function === "object" ? obj.function : null;
  const name = typeof obj.name === "string" ? obj.name
    : typeof obj.function === "string" ? obj.function
    : typeof obj.tool === "string" ? obj.tool
    : fn && typeof fn.name === "string" ? fn.name : null;
  if (!name || !known.has(name)) return null;
  const rawArgs = fn ? (fn.arguments ?? fn.parameters) : (obj.arguments ?? obj.parameters ?? obj.args ?? {});
  const args = typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs ?? {});
  return { name, arguments: args };
}

/**
 * Tool calls a model wrote as TEXT, limited to `knownNames`. Returns [] when
 * the text holds none. Exported for tests.
 */
export function recoverTextToolCalls(text: string, knownNames: Iterable<string>): ChatToolCall[] {
  const known = new Set(knownNames);
  if (!text || known.size === 0) return [];
  const calls: ChatToolCall[] = [];
  for (let i = text.indexOf("{"); i !== -1; ) {
    const blob = balancedObjectAt(text, i);
    if (!blob) break;
    let parsed: any;
    try { parsed = JSON.parse(blob); } catch { parsed = null; }
    const list = Array.isArray(parsed?.tool_calls) ? parsed.tool_calls : [parsed];
    let matched = false;
    for (const item of list) {
      const call = asCall(item, known);
      if (call) {
        calls.push({ id: `text_call_${calls.length}`, type: "function", function: call });
        matched = true;
      }
    }
    i = text.indexOf("{", matched ? i + blob.length : i + 1);
  }
  return calls;
}

/**
 * Parse one SSE `data:` payload from a streamed chat completion into the
 * running round. Exported for tests.
 */
export function applyStreamChunk(
  round: { content: string; toolCalls: Map<number, ChatToolCall>; finishReason: string | null; reasoningChars?: number },
  data: Record<string, any>,
): string {
  const choice = Array.isArray(data?.choices) ? data.choices[0] : undefined;
  if (!choice) return "";
  const delta = choice.delta ?? choice.message ?? {};
  let text = "";
  if (typeof delta.content === "string" && delta.content) {
    text = delta.content;
    round.content += text;
  }
  // A thinking model's reasoning arrives in its own field — `reasoning`
  // (Ollama) or `reasoning_content` (vLLM, DeepSeek-style servers). It is
  // never shown or stored; only its length is counted, so the widget can say
  // the model is working during a long silent think.
  const reasoning = typeof delta.reasoning === "string" ? delta.reasoning
    : typeof delta.reasoning_content === "string" ? delta.reasoning_content : "";
  if (reasoning) round.reasoningChars = (round.reasoningChars ?? 0) + reasoning.length;
  if (Array.isArray(delta.tool_calls)) {
    for (const [pos, tc] of delta.tool_calls.entries()) {
      const idx = typeof tc.index === "number" ? tc.index : pos;
      const cur = round.toolCalls.get(idx) ?? { id: "", type: "function" as const, function: { name: "", arguments: "" } };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.function.name += tc.function.name;
      if (typeof tc.function?.arguments === "string") cur.function.arguments += tc.function.arguments;
      else if (tc.function?.arguments && typeof tc.function.arguments === "object") {
        // Some servers (Ollama's native shape leaking through) send an object.
        cur.function.arguments = JSON.stringify(tc.function.arguments);
      }
      round.toolCalls.set(idx, cur);
    }
  }
  if (choice.finish_reason) round.finishReason = choice.finish_reason;
  return text;
}

/**
 * One chat-completions round. Streams text through `onText`; returns the
 * full text plus any tool calls the model asked for.
 */
export async function chatCompletionRound(
  config: LlmConfig,
  messages: ChatMessage[],
  tools: ChatToolDef[],
  opts: { signal?: AbortSignal; onText?: (text: string) => void; onReasoning?: (totalChars: number) => void } = {},
): Promise<CompletionRound> {
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    stream: true,
    temperature: config.temperature ?? LLM_DEFAULTS.temperature,
  };
  if (tools.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  const res = await openRequest(config, "POST", "/chat/completions", body, opts.signal);
  if (res.status < 200 || res.status >= 300) {
    throw upstreamError(res.status, await readAll(res.stream));
  }

  const round = { content: "", toolCalls: new Map<number, ChatToolCall>(), finishReason: null as string | null, reasoningChars: 0 };

  try {
    await readRound(config, res, round, opts.onText, opts.onReasoning);
  } catch (err) {
    // An abort mid-body surfaces from the socket as ECONNRESET "aborted", not
    // as an AbortError — normalize it so callers can tell Stop from a failure.
    if (opts.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    throw err;
  }

  const toolCalls = Array.from(round.toolCalls.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([i, tc]) => ({ ...tc, id: tc.id || `call_${i}` }))
    .filter((tc) => tc.function.name);
  return { content: round.content, toolCalls, finishReason: round.finishReason };
}

async function readRound(
  config: LlmConfig,
  res: RawResponse,
  round: { content: string; toolCalls: Map<number, ChatToolCall>; finishReason: string | null; reasoningChars: number },
  onText: ((text: string) => void) | undefined,
  onReasoning?: (totalChars: number) => void,
): Promise<void> {
  const opts = { onText };
  if (!res.contentType.includes("text/event-stream")) {
    // The server ignored stream:true — one JSON body.
    const raw = await readAll(res.stream);
    let j: any;
    try { j = JSON.parse(raw); } catch { throw new AppError(502, "LLM server returned a response that is not JSON"); }
    const text = applyStreamChunk(round, j);
    if (text) opts.onText?.(text);
  } else {
    let buf = "";
    for await (const chunk of res.stream) {
      buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        let parsed: any;
        try { parsed = JSON.parse(data); } catch {
          if (config.verboseLogging) logger.debug({ data: data.slice(0, 200) }, "llm: unparseable SSE chunk skipped");
          continue;
        }
        if (parsed?.error) throw upstreamError(500, JSON.stringify(parsed));
        const before = round.reasoningChars;
        const text = applyStreamChunk(round, parsed);
        if (text) opts.onText?.(text);
        if (round.reasoningChars !== before) onReasoning?.(round.reasoningChars);
      }
    }
  }
}
