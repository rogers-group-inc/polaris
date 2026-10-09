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
 * Providers (rule 95(j)): `provider` absent or "openai" is everything above.
 * "azure" is Azure AI Foundry's Azure OpenAI deployments — the same chat
 * dialect on a different path (`/openai/v1/chat/completions`, or the legacy
 * `/openai/deployments/<name>/chat/completions?api-version=…`), authenticated
 * by an `api-key` header or an Entra ID client-credentials bearer token, with
 * `model` holding the DEPLOYMENT name. Foundry cannot list deployments, so
 * listModels refuses and testConnection sends one tiny chat round instead.
 * Every provider difference lives in this file; the chat orchestrator only
 * ever sees chatCompletionRound.
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
import { createHash } from "node:crypto";
import { AppError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { buildClientCredentialsTokenRequest } from "../utils/entraClientCredentials.js";
import Anthropic from "@anthropic-ai/sdk";
import AnthropicFoundry from "@anthropic-ai/foundry-sdk";

export type LlmProvider = "openai" | "azure";

export interface LlmConfig {
  /** Absent = "openai" (any OpenAI-compatible server) — every row made before Azure support. */
  provider?: LlmProvider;
  /**
   * Azure: "v1" (`/openai/v1/…`, no api-version) or the legacy "deployments" path — both Azure OpenAI
   * GPT deployments on chat completions — or "anthropic": a Claude deployment, spoken to through
   * Anthropic's official Foundry SDK on the Messages API (`/anthropic/v1/messages`).
   */
  azureApiShape?: "v1" | "deployments" | "anthropic";
  /** Azure "deployments" shape only, e.g. "2024-10-21". */
  azureApiVersion?: string;
  /** Azure: an `api-key` header (the key lives in apiToken) or an Entra ID service principal. */
  azureAuth?: "apiKey" | "entra";
  tenantId?: string;
  clientId?: string;
  clientSecret?: string;
  /** Entra token scope; blank = AZURE_DEFAULTS.scope. */
  azureScope?: string;
  /** Never send `temperature` — reasoning deployments (o-series, gpt-5) refuse it. */
  omitTemperature?: boolean;
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
  /**
   * `raw`: the provider's own content for this turn (CompletionRound.raw), replayed VERBATIM
   * to the same provider. Claude needs its thinking blocks sent back unchanged with the
   * tool_use blocks they preceded; nothing else reads it.
   */
  | { role: "assistant"; content: string | null; tool_calls?: ChatToolCall[]; raw?: unknown }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ChatToolDef {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface CompletionRound {
  content: string;
  toolCalls: ChatToolCall[];
  finishReason: string | null;
  /** Provider-native content to replay on the next round's assistant message (see ChatMessage.raw). */
  raw?: unknown;
}

export const AZURE_DEFAULTS = {
  apiShape: "v1",
  /** Latest GA dated version for the legacy deployments path. */
  apiVersion: "2024-10-21",
  scope: "https://cognitiveservices.azure.com/.default",
  /** The Entra audience of a Claude deployment (the Messages API on `services.ai.azure.com`). */
  anthropicScope: "https://ai.azure.com/.default",
} as const;

/** The api-version form Azure accepts: a date, optionally "-preview". */
export const AZURE_API_VERSION_RE = /^\d{4}-\d{2}-\d{2}(-preview)?$/;

export function isAzureProvider(config: Pick<LlmConfig, "provider">): boolean {
  return config.provider === "azure";
}

/** Normalize the operator-entered path prefix: leading slash, no trailing slash. */
export function normalizeBasePath(p: string | undefined): string {
  const raw = (p ?? LLM_DEFAULTS.basePath).trim();
  if (!raw || raw === "/") return "";
  const withLead = raw.startsWith("/") ? raw : `/${raw}`;
  return withLead.replace(/\/+$/, "");
}

/**
 * The path prefix requests are built under. For an OpenAI-compatible server it
 * is the API path ("/v1" when unset). For Azure it is empty unless the
 * endpoint sits behind a gateway that adds one — never a default "/v1",
 * because Azure's own paths already start at "/openai".
 */
function basePrefix(config: LlmConfig): string {
  return isAzureProvider(config) ? normalizeBasePath(config.basePath ?? "") : normalizeBasePath(config.basePath);
}

/**
 * Azure's chat-completions path for the configured API shape. The deployment
 * name rides `model`; on the legacy shape it is a path segment, so it is
 * encoded. Exported for tests.
 */
export function azureChatPath(config: LlmConfig): string {
  const prefix = basePrefix(config);
  if ((config.azureApiShape ?? AZURE_DEFAULTS.apiShape) === "deployments") {
    const version = (config.azureApiVersion ?? "").trim() || AZURE_DEFAULTS.apiVersion;
    return `${prefix}/openai/deployments/${encodeURIComponent((config.model ?? "").trim())}/chat/completions?api-version=${encodeURIComponent(version)}`;
  }
  return `${prefix}/openai/v1/chat/completions`;
}

/** The full request path for chat completions, per provider. Exported for tests. */
export function chatCompletionsPath(config: LlmConfig): string {
  return isAzureProvider(config) ? azureChatPath(config) : `${basePrefix(config)}/chat/completions`;
}

/**
 * Split a pasted Azure endpoint ("https://res.openai.azure.com/",
 * "https://res.services.ai.azure.com/openai/v1", "res.openai.azure.com") into
 * the host / port / scheme / prefix the transport uses. Anything from
 * "/openai" on is dropped — Polaris builds that part per API shape. Returns
 * null for text that is not a host or URL. Exported for tests and the route.
 */
export function parseAzureEndpoint(input: string): { host: string; port: number; useHttps: boolean; basePath: string } | null {
  const raw = (input ?? "").trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!url.hostname) return null;
  const useHttps = url.protocol === "https:";
  const port = url.port ? Number(url.port) : useHttps ? 443 : 80;
  let path = url.pathname.replace(/\/+$/, "");
  const cut = path.search(/\/(openai|anthropic)(\/|$)/i);
  if (cut !== -1) path = path.slice(0, cut);
  // URL keeps IPv6 literals bracketed; the transport wants the bare address.
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  return { host, port, useHttps, basePath: path };
}

/**
 * The authentication headers for one request: a Bearer API key for an
 * OpenAI-compatible server (only when one is set), `api-key` for an Azure
 * key, or the Entra access token as a Bearer. Exported for tests.
 */
export function llmAuthHeaders(config: LlmConfig, entraToken?: string): Record<string, string> {
  if (isAzureProvider(config)) {
    if ((config.azureAuth ?? "apiKey") === "entra") {
      return entraToken ? { Authorization: `Bearer ${entraToken}` } : {};
    }
    return config.apiToken ? { "api-key": config.apiToken } : {};
  }
  return config.apiToken ? { Authorization: `Bearer ${config.apiToken}` } : {};
}

// ─── Entra ID token (Azure, azureAuth "entra") ───────────────────────────────
//
// Client credentials against login.microsoftonline.com, the request shape
// shared with entraIdService / azureArcService. Cached per tenant | client |
// scope | sha256(secret) — a rotated secret is a new key, so a token minted
// with the old one is never reused — and refreshed 5 minutes before expiry.
// Concurrent turns share one in-flight fetch. A failure is never cached. The
// token and the secret are never logged.

const ENTRA_REFRESH_MARGIN_MS = 5 * 60_000;
const entraTokenCache = new Map<string, { token: string; expiresAt: number }>();
const entraInFlight = new Map<string, Promise<string>>();

function entraCacheKey(config: LlmConfig): string {
  const secretHash = createHash("sha256").update(config.clientSecret ?? "").digest("hex");
  return [config.tenantId ?? "", config.clientId ?? "", azureScope(config), secretHash].join("|");
}

/** The Entra scope: the operator's, else the default for the API shape. Exported for tests. */
export function azureScope(config: LlmConfig): string {
  return (config.azureScope ?? "").trim()
    || (config.azureApiShape === "anthropic" ? AZURE_DEFAULTS.anthropicScope : AZURE_DEFAULTS.scope);
}

/** An Entra access token for the Azure data plane, from cache when fresh. Exported for tests. */
export async function getAzureEntraToken(config: LlmConfig): Promise<string> {
  if (!config.tenantId || !config.clientId || !config.clientSecret) {
    throw new AppError(400, "Entra ID authentication needs a tenant ID, client ID and client secret");
  }
  const key = entraCacheKey(config);
  const cached = entraTokenCache.get(key);
  if (cached && cached.expiresAt - ENTRA_REFRESH_MARGIN_MS > Date.now()) return cached.token;
  const pending = entraInFlight.get(key);
  if (pending) return pending;
  const p = fetchEntraToken(config)
    .then(({ token, expiresInSec }) => {
      entraTokenCache.set(key, { token, expiresAt: Date.now() + expiresInSec * 1000 });
      return token;
    })
    .finally(() => entraInFlight.delete(key));
  entraInFlight.set(key, p);
  return p;
}

async function fetchEntraToken(config: LlmConfig): Promise<{ token: string; expiresInSec: number }> {
  const { url, body } = buildClientCredentialsTokenRequest({
    tenantId: config.tenantId!,
    clientId: config.clientId!,
    clientSecret: config.clientSecret!,
    scope: azureScope(config),
  });
  let res: Response;
  try {
    res = await globalThis.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err: any) {
    throw new AppError(502, `Could not reach Entra ID (login.microsoftonline.com) for a token: ${err?.message || err}`);
  }
  const text = await res.text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok) {
    // error_description carries the AADSTS code and reason; never the secret.
    const why = parsed?.error_description ? String(parsed.error_description).split(/\r?\n/)[0]
      : parsed?.error ? String(parsed.error) : `HTTP ${res.status}`;
    throw new AppError(502, `Entra ID refused the token request (HTTP ${res.status}): ${why.slice(0, 300)}`);
  }
  if (!parsed?.access_token) throw new AppError(502, "Entra ID token response had no access_token");
  const expiresInSec = Number(parsed.expires_in) > 0 ? Number(parsed.expires_in) : 3600;
  return { token: String(parsed.access_token), expiresInSec };
}

function invalidateEntraToken(config: LlmConfig): void {
  entraTokenCache.delete(entraCacheKey(config));
}

/** Test hook. */
export function _clearEntraTokenCache(): void {
  entraTokenCache.clear();
  entraInFlight.clear();
}

/** Human-readable endpoint for messages and the integration card. */
export function describeEndpoint(config: LlmConfig): string {
  const scheme = config.useHttps ? "https" : "http";
  const port = config.port ?? LLM_DEFAULTS.port;
  return `${scheme}://${config.host}:${port}${basePrefix(config)}`;
}

interface RawResponse {
  status: number;
  contentType: string;
  stream: http.IncomingMessage;
}

/** `path` is the FULL request path (prefix included) — see chatCompletionsPath. */
async function openRequest(
  config: LlmConfig,
  method: "GET" | "POST",
  path: string,
  body: unknown,
  signal: AbortSignal | undefined,
): Promise<RawResponse> {
  if (!config.host) throw new AppError(400, "LLM host is required");
  const mod = config.useHttps ? https : http;
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const headers: Record<string, string> = { Accept: "application/json, text/event-stream" };
  if (payload !== undefined) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = String(Buffer.byteLength(payload));
  }
  const entraToken = isAzureProvider(config) && config.azureAuth === "entra" ? await getAzureEntraToken(config) : undefined;
  Object.assign(headers, llmAuthHeaders(config, entraToken));
  const timeout = config.requestTimeoutMs ?? LLM_DEFAULTS.requestTimeoutMs;

  return new Promise((resolve, reject) => {
    const req = mod.request(
      {
        host: config.host,
        port: config.port ?? LLM_DEFAULTS.port,
        method,
        path,
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

function upstreamDetail(body: string): string {
  let detail: unknown = body.trim();
  try {
    const j = JSON.parse(body);
    detail = j?.error?.message ?? j?.error ?? j?.message ?? detail;
  } catch { /* plain-text body */ }
  return typeof detail === "string" ? detail : JSON.stringify(detail);
}

/** How messages name an Azure API shape: "v1 API", "deployments API 2024-10-21", "Claude Messages API". */
function apiShapeLabel(config: LlmConfig): string {
  const shape = config.azureApiShape ?? AZURE_DEFAULTS.apiShape;
  if (shape === "anthropic") return "Claude Messages API";
  if (shape === "deployments") return `deployments API ${(config.azureApiVersion ?? "").trim() || AZURE_DEFAULTS.apiVersion}`;
  return "v1 API";
}

/** Exported for tests. */
export function upstreamError(status: number, body: string, config?: LlmConfig): AppError {
  const detail = upstreamDetail(body);
  if (config && isAzureProvider(config)) {
    const entra = config.azureAuth === "entra";
    if (status === 401) {
      return new AppError(502, entra
        ? `Azure AI Foundry refused the Entra ID token (HTTP 401) — check the tenant ID and that the token scope is ${azureScope(config)}`
        : "Azure AI Foundry refused the API key (HTTP 401) — copy Key 1 or Key 2 from the resource's Keys and Endpoint page");
    }
    if (status === 403) {
      return new AppError(502, entra
        ? "Azure AI Foundry refused the app registration (HTTP 403) — grant its service principal the Cognitive Services OpenAI User role on the resource"
        : `Azure AI Foundry refused the request (HTTP 403): ${detail.slice(0, 300)}`);
    }
    if (status === 404) {
      return new AppError(502, `Deployment "${(config.model ?? "").trim()}" was not found at ${describeEndpoint(config)} (HTTP 404) — Model must be the DEPLOYMENT name, and the resource must support the ${apiShapeLabel(config)}`);
    }
    return new AppError(502, `Azure AI Foundry error (HTTP ${status}): ${detail.slice(0, 300)}`);
  }
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
  if (isAzureProvider(config)) return null;
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
  if (isAzureProvider(config)) {
    throw new AppError(400, "Azure AI Foundry cannot list deployments — enter the deployment name as Model");
  }
  const res = await openRequest({ ...config, requestTimeoutMs: Math.min(config.requestTimeoutMs ?? 15_000, 15_000) }, "GET", `${basePrefix(config)}/models`, undefined, undefined);
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
  if (isAzureProvider(config)) return testAzureConnection(config);
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

/**
 * Azure Test Connection: Foundry has no deployment list, so the only proof
 * that the endpoint, the credential AND the deployment are right is one tiny
 * chat round (no tools). Its failures already name the auth mode — an AADSTS
 * reason from the token request, or upstreamError's 401 / 403 / 404 wording.
 */
async function testAzureConnection(config: LlmConfig): Promise<LlmTestResult> {
  const deployment = (config.model ?? "").trim();
  if (!deployment) return { ok: false, message: "Model (the deployment name) is required for Azure AI Foundry", model: null };
  const how = config.azureAuth === "entra" ? "Entra ID app" : "API key";
  const shape = apiShapeLabel(config);
  try {
    await chatCompletionRound(
      config,
      [
        { role: "system", content: "You are a connectivity check. Reply with the single word OK." },
        { role: "user", content: "ping" },
      ],
      [],
      { signal: AbortSignal.timeout(Math.min(config.requestTimeoutMs ?? LLM_DEFAULTS.requestTimeoutMs, 90_000)) },
    );
  } catch (err: any) {
    if (err?.name === "AbortError" || err?.name === "TimeoutError") {
      return { ok: false, message: `Deployment "${deployment}" did not answer within 90 s`, model: null };
    }
    return { ok: false, message: err instanceof AppError ? err.message : err?.message || "Unknown error", model: null };
  }
  return {
    ok: true,
    message: `Connected — Azure AI Foundry deployment "${deployment}" answered (${shape}, ${how}). Tool calling not verified — use Check tool calling`,
    model: deployment,
  };
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
  if (isAzureProvider(config)) throw new AppError(409, "Set Model on the integration to the Azure deployment name");
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

// ─── Claude on Azure AI Foundry (azureApiShape "anthropic") ──────────────────
//
// Claude deployments speak Anthropic's Messages API, not chat completions, so
// this shape goes through Anthropic's official Foundry SDK rather than the
// hand-rolled transport above. The orchestrator still sees ONE dialect: the
// OpenAI-shaped history is translated here (toAnthropicRequest) and the
// answer translated back into a CompletionRound. Auth reuses the Entra token
// cache above (scope https://ai.azure.com/.default) or the key in apiToken.
// Every credential is passed explicitly, never left to the SDK's
// ANTHROPIC_FOUNDRY_* environment fallbacks, so a stray variable on the host
// can never change who Polaris authenticates as.

/** Output ceiling per round. Required by the Messages API; only what is generated is billed. */
export const ANTHROPIC_MAX_TOKENS = 64_000;

export function isAnthropicShape(config: LlmConfig): boolean {
  return isAzureProvider(config) && config.azureApiShape === "anthropic";
}

/** The SDK's base URL for a Claude deployment: `<scheme>://<host>[:port]<prefix>/anthropic/`. Exported for tests. */
export function anthropicBaseUrl(config: LlmConfig): string {
  const useHttps = config.useHttps !== false;
  const host = config.host.includes(":") ? `[${config.host}]` : config.host;
  const port = config.port && config.port !== (useHttps ? 443 : 80) ? `:${config.port}` : "";
  return `${useHttps ? "https" : "http"}://${host}${port}${basePrefix(config)}/anthropic/`;
}

type AnthropicBlock = Record<string, unknown>;
type AnthropicTurn = { role: "user" | "assistant"; content: string | AnthropicBlock[] };

/**
 * Translate the orchestrator's OpenAI-shaped messages into a Messages API
 * request. Leading system messages become `system`; a later one (Polaris's
 * mid-turn notes) rides as a text block on the user turn it follows, which
 * every Claude model accepts. Tool results are grouped into ONE user turn
 * right after the assistant turn that asked for them. An assistant turn
 * carrying `raw` is replayed verbatim (thinking blocks included). Exported
 * for tests.
 */
export function toAnthropicRequest(messages: ChatMessage[], tools: ChatToolDef[]): {
  system: string;
  messages: AnthropicTurn[];
  tools: AnthropicBlock[];
} {
  const system: string[] = [];
  const out: AnthropicTurn[] = [];
  let started = false;
  const userBlocks = (): AnthropicBlock[] => {
    const last = out[out.length - 1];
    if (last && last.role === "user") {
      if (typeof last.content === "string") last.content = [{ type: "text", text: last.content }];
      return last.content as AnthropicBlock[];
    }
    const turn: AnthropicTurn = { role: "user", content: [] };
    out.push(turn);
    return turn.content as AnthropicBlock[];
  };
  for (const m of messages) {
    if (m.role === "system") {
      if (!started) system.push(m.content);
      else userBlocks().push({ type: "text", text: m.content });
      continue;
    }
    started = true;
    if (m.role === "user") {
      userBlocks().push({ type: "text", text: m.content });
    } else if (m.role === "tool") {
      userBlocks().push({ type: "tool_result", tool_use_id: m.tool_call_id, content: m.content });
    } else if (m.role !== "assistant") {
      continue;
    } else if (Array.isArray(m.raw)) {
      out.push({ role: "assistant", content: m.raw as AnthropicBlock[] });
    } else {
      const blocks: AnthropicBlock[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const tc of m.tool_calls ?? []) {
        let input: unknown = {};
        try { input = JSON.parse(tc.function.arguments || "{}"); } catch { input = {}; }
        blocks.push({ type: "tool_use", id: tc.id, name: tc.function.name, input: input && typeof input === "object" ? input : {} });
      }
      if (blocks.length) out.push({ role: "assistant", content: blocks });
    }
  }
  // A single text block reads more simply as a string.
  for (const t of out) {
    if (Array.isArray(t.content) && t.content.length === 1 && t.content[0].type === "text") t.content = String(t.content[0].text);
  }
  return {
    system: system.join("\n\n"),
    messages: out,
    tools: tools.map((t) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters })),
  };
}

function anthropicClient(config: LlmConfig): AnthropicFoundry {
  const entra = config.azureAuth === "entra";
  // `null`, not undefined: undefined would fall through to the SDK's env-var defaults.
  return new AnthropicFoundry({
    baseURL: anthropicBaseUrl(config),
    resource: null as unknown as undefined,
    apiKey: (entra ? null : config.apiToken || null) as unknown as undefined,
    ...(entra ? { azureADTokenProvider: () => getAzureEntraToken(config) } : {}),
    timeout: config.requestTimeoutMs ?? LLM_DEFAULTS.requestTimeoutMs,
    maxRetries: 2,
  });
}

/** Map an SDK failure onto the same AppErrors (and the same wording) as the other shapes. */
function anthropicError(err: unknown, config: LlmConfig, signal: AbortSignal | undefined): Error {
  if (signal?.aborted || err instanceof Anthropic.APIUserAbortError) {
    return Object.assign(new Error("aborted"), { name: "AbortError" });
  }
  if (err instanceof AppError) return err;
  if (err instanceof Anthropic.APIError && typeof err.status === "number") {
    if (err.status === 401 && config.azureAuth === "entra") invalidateEntraToken(config);
    const detail = (err.error as { error?: { message?: string } } | undefined)?.error?.message ?? err.message;
    return upstreamError(err.status, JSON.stringify({ error: { message: detail } }), config);
  }
  const cause = (err as { cause?: unknown })?.cause;
  if (cause instanceof AppError) return cause; // an Entra token failure, surfaced through the SDK
  return new AppError(502, `Could not reach Azure AI Foundry at ${describeEndpoint(config)}: ${(err as Error)?.message || err}`);
}

async function anthropicRound(
  config: LlmConfig,
  messages: ChatMessage[],
  tools: ChatToolDef[],
  opts: { signal?: AbortSignal; onText?: (text: string) => void; onReasoning?: (totalChars: number) => void },
): Promise<CompletionRound> {
  const req = toAnthropicRequest(messages, tools);
  const params: Record<string, unknown> = {
    model: config.model,
    max_tokens: ANTHROPIC_MAX_TOKENS,
    messages: req.messages,
  };
  // No `temperature`: current Claude models refuse non-default sampling.
  // No `thinking`: the model's adaptive default.
  if (req.system) params.system = req.system;
  if (req.tools.length) {
    params.tools = req.tools;
    params.tool_choice = { type: "auto" };
  }
  const idleMs = config.requestTimeoutMs ?? LLM_DEFAULTS.requestTimeoutMs;
  let idle: NodeJS.Timeout | undefined;
  let stalled = false;
  let stream: ReturnType<AnthropicFoundry["messages"]["stream"]> | undefined;
  try {
    stream = anthropicClient(config).messages.stream(params as never, { signal: opts.signal });
    // The SDK's own timeout ends at the response headers; a body that stalls
    // mid-answer is caught here, the same idle rule as the other transport.
    const arm = () => {
      clearTimeout(idle);
      idle = setTimeout(() => { stalled = true; stream?.abort(); }, idleMs);
    };
    arm();
    let reasoning = 0;
    for await (const ev of stream as AsyncIterable<{ type: string; delta?: { type?: string; text?: string; thinking?: string } }>) {
      arm();
      if (ev.type !== "content_block_delta" || !ev.delta) continue;
      if (ev.delta.type === "text_delta" && ev.delta.text) opts.onText?.(ev.delta.text);
      else if (ev.delta.type === "thinking_delta" && ev.delta.thinking) {
        reasoning += ev.delta.thinking.length;
        opts.onReasoning?.(reasoning);
      }
    }
    const final = await stream.finalMessage();
    clearTimeout(idle);
    const blocks = final.content as unknown as AnthropicBlock[];
    const text = blocks.filter((b) => b.type === "text").map((b) => String(b.text ?? "")).join("");
    if (final.stop_reason === "refusal" && !text) {
      throw new AppError(502, "The model declined to answer this request (refusal)");
    }
    const toolCalls: ChatToolCall[] = blocks
      .filter((b) => b.type === "tool_use")
      .map((b) => ({ id: String(b.id), type: "function" as const, function: { name: String(b.name), arguments: JSON.stringify(b.input ?? {}) } }));
    const finishReason = final.stop_reason === "tool_use" ? "tool_calls"
      : final.stop_reason === "end_turn" ? "stop"
      : final.stop_reason === "max_tokens" ? "length"
      : final.stop_reason ?? null;
    return { content: text, toolCalls, finishReason, raw: blocks };
  } catch (err) {
    clearTimeout(idle);
    if (stalled && !opts.signal?.aborted) {
      throw new AppError(504, `LLM server did not respond within ${Math.round(idleMs / 1000)}s`);
    }
    throw anthropicError(err, config, opts.signal);
  }
}

// Azure deployments that answered 400 to `temperature`, by host + path + deployment.
const refusesTemperature = new Set<string>();
function temperatureKey(config: LlmConfig): string {
  return `${config.host}|${basePrefix(config)}|${(config.model ?? "").trim()}`;
}

/** Test hook. */
export function _clearTemperatureRefusals(): void {
  refusesTemperature.clear();
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
  if (isAnthropicShape(config)) return anthropicRound(config, messages, tools, opts);
  const azure = isAzureProvider(config);
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    stream: true,
  };
  if (!(azure && (config.omitTemperature || refusesTemperature.has(temperatureKey(config))))) {
    body.temperature = config.temperature ?? LLM_DEFAULTS.temperature;
  }
  if (tools.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  let res = await openRequest(config, "POST", chatCompletionsPath(config), body, opts.signal);
  if (azure && res.status === 400 && body.temperature !== undefined) {
    // A reasoning deployment (o-series, gpt-5…) answers 400 naming
    // `temperature`. Retry once without it, and remember the refusal for
    // this deployment so later rounds do not pay the extra request.
    const errBody = await readAll(res.stream);
    if (!/temperature/i.test(errBody)) throw upstreamError(res.status, errBody, config);
    refusesTemperature.add(temperatureKey(config));
    delete body.temperature;
    res = await openRequest(config, "POST", chatCompletionsPath(config), body, opts.signal);
  }
  if (res.status < 200 || res.status >= 300) {
    // A stale cached Entra token (revoked, or minted before a role change)
    // must not be reused for the next request.
    if (azure && config.azureAuth === "entra" && res.status === 401) invalidateEntraToken(config);
    throw upstreamError(res.status, await readAll(res.stream), config);
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
        if (parsed?.error) throw upstreamError(500, JSON.stringify(parsed), config);
        const before = round.reasoningChars;
        const text = applyStreamChunk(round, parsed);
        if (text) opts.onText?.(text);
        if (round.reasoningChars !== before) onReasoning?.(round.reasoningChars);
      }
    }
  }
}
