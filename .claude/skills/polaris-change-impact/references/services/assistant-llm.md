# Services — the AI assistant and the `llm` integration

The floating chat assistant (business rule 95) and the integration type that backs it. Nine
services: the transport to the model server, the tool layer that answers its lookups, the
turn orchestrator, its playbooks, the conversation store, the per-user memory, the help index over
`docs/wiki/`, and the role + API token an llm integration provisions. Route: `src/api/routes/assistant.ts`
(`/api/v1/assistant`, `assistant` read, session-only); integration CRUD stays in
`src/api/routes/integrations.ts`. Frontend: `public/js/assistant.js`,
`public/js/assistant-markdown.js`, `public/css/assistant.css` (booted by
`public/js/app.js → _bootAssistant()`), and the AI Assistant form in `public/js/integrations.js`.

---

## services/llmService.ts

**What it owns:** The `llm` integration's transport — an OpenAI-compatible chat-completions client over `node:http`/`node:https` (so `verifySsl: false` works against a self-signed lab server without undici). `GET {base}/models` for Test Connection (and the model-is-listed check, Ollama's `:latest` form included); `POST {base}/chat/completions` with `stream: true` + `tools` for each round, parsing the SSE body incrementally. Text deltas are handed to `onText` as they arrive; tool-call deltas (name and JSON arguments arrive in fragments) are accumulated by `index` and returned whole. A server that ignores `stream:true` and answers with one JSON body is handled. An abort mid-body (which the socket reports as ECONNRESET) is normalized to an `AbortError`.

**Model discovery (2026-10-07):** `listModels` reads `{base}/models`, then — only when the API path is `/v1` or empty, because Open WebUI also answers `/api/…` — recognizes Ollama by `/api/tags` and reads each model's `capabilities` from `/api/show` (≤40 models, 4 at a time). `toolCalling` is `yes`/`no` from those capabilities and `unknown` otherwise, never guessed from the name; embedding-only models (Ollama's `embedding` without `completion`, else a conservative name pattern) are dropped unless they are all there is. `probeToolCalling` is the operator-triggered check for an `unknown` model: one request offering a dummy `polaris_probe` tool, `yes` if it is called, `no` on prose or a server that rejects `tools`. A blank `model` is legal: `pickDefaultModel` (first tool-calling, else first chat model) via `resolveChatModel`, cached per integration for 5 minutes. `displayName` is the name the chat window shows and the system prompt gives the model.

**Tool calls written as text:** small local models sometimes write a tool call into the reply instead of emitting `tool_calls` — and once one such reply is in the history, copy it every turn after (qwen2.5:7b on Ollama, 2026-10-07: 6/6 structured on a fresh thread, text-only once a text-mode reply was in history). `recoverTextToolCalls(text, knownNames)` recovers fenced / bare / `<tool_call>` JSON naming ONLY a tool the request offered; the chat service runs it, emits `retract { from }` and keeps that round's text out of both the stored answer and the history it sends back.

**Reasoning progress + context window (2026-10-07):** a thinking model (qwen3, DeepSeek-R1…) streams its reasoning in `delta.reasoning` (Ollama) or `delta.reasoning_content` (vLLM / DeepSeek-style). `applyStreamChunk` only COUNTS it (`round.reasoningChars`) — it is never added to `content`, shown or stored — and `chatCompletionRound`'s `onReasoning(totalChars)` reports the running count per round. `LlmConfig.contextWindow` (default 8192, `LLM_DEFAULTS.contextWindow`) is the server's window as the operator states it; `estimateTokens` (~3.5 chars a token) is the deliberately rough measure the chat service budgets with. `testConnection` appends a warning when the window is under `SMALL_CONTEXT_WINDOW` (6000): the instructions plus tool definitions alone are ~2 700 tokens, so Ollama's 4096 default leaves room for the question and almost nothing else.

**Azure AI Foundry provider (rule 95(j), 2026-10-09):** `LlmConfig.provider` absent / `"openai"` is everything above; `"azure"` is an Azure OpenAI deployment in Foundry — the same chat dialect, so streaming, tool calls and `applyStreamChunk` are shared (which already tolerates Azure's filter-only first chunk, `choices: []`). The differences, all here: `chatCompletionsPath` → `azureChatPath` builds `{prefix}/openai/v1/chat/completions` (`azureApiShape` `v1`, the default, no api-version) or `{prefix}/openai/deployments/<encoded deployment>/chat/completions?api-version=…` (default `AZURE_DEFAULTS.apiVersion`); the Azure prefix defaults to EMPTY, never the OpenAI `/v1`. `model` is the deployment name. `llmAuthHeaders` sends `api-key: <apiToken>` (`azureAuth` `apiKey`) or `Authorization: Bearer <Entra token>` (`entra`); an OpenAI-compatible server keeps `Bearer <apiToken>`. `getAzureEntraToken` uses `utils/entraClientCredentials.buildClientCredentialsTokenRequest` over global `fetch`, scope `azureScope` (default `https://cognitiveservices.azure.com/.default`), cached per tenant | client | scope | sha256(secret), refreshed 5 min before expiry, one in-flight fetch shared, failures never cached, the cache entry dropped when the data plane answers 401. `parseAzureEndpoint` splits a pasted URL into host / port / useHttps / basePath (dropping everything from `/openai`) — the route's `LlmConfigSchema` preprocess calls it. `listModels` refuses for Azure (Foundry cannot list deployments), `ollamaCapabilities` returns null, `resolveChatModel` refuses a blank deployment, and `testConnection` sends ONE tiny chat round with no tools (`testAzureConnection`). `chatCompletionRound` omits `temperature` when `omitTemperature` is set, and on an Azure 400 whose body names `temperature` retries ONCE without it and remembers the refusal per host | prefix | deployment (`refusesTemperature`). `upstreamError(status, body, config)` words Azure 401 / 403 / 404 by auth mode and names the deployment. Neither `max_tokens` nor `max_completion_tokens` is sent on the GPT shapes. **Claude (`azureApiShape: "anthropic"`, 2026-10-09):** a Claude deployment speaks Anthropic's Messages API, so `chatCompletionRound` hands it to `anthropicRound`, which uses the OFFICIAL SDK (`@anthropic-ai/foundry-sdk` → `AnthropicFoundry`, base URL `anthropicBaseUrl` = `<scheme>://<host>[:port]<prefix>/anthropic/`). `toAnthropicRequest` translates the OpenAI-shaped history: leading system messages → `system`; a later system message (a mid-turn operator note) → a text block on the user turn it follows; tool results grouped into ONE user turn; an assistant turn carrying `raw` (the previous round's Claude blocks, thinking + signature) replayed VERBATIM — `CompletionRound.raw` / `ChatMessage.raw` exist for this, and the chat service passes `raw` only for calls the model really made. Sent: `max_tokens: ANTHROPIC_MAX_TOKENS` (64 000, required by the API), no `temperature`, no `thinking` (the model's adaptive default). Credentials are passed explicitly (`apiKey: null` in Entra mode, `resource: null`) so the SDK's `ANTHROPIC_FOUNDRY_*` env fallbacks never apply; Entra goes through `getAzureEntraToken` with `azureScope` → `https://ai.azure.com/.default` for this shape (blank scope = the shape's default). The SDK's `timeout` ends at the response headers, so `anthropicRound` keeps its own idle watchdog (`requestTimeoutMs`, aborts → 504). SDK errors map through `anthropicError` onto `upstreamError` (401 drops the cached Entra token); a user abort → `AbortError`; `stop_reason: "refusal"` with no text → 502. The SDK retries 429 / 5xx twice (`maxRetries: 2`).

**Public API:** LlmConfig, LlmProvider, LLM_DEFAULTS, AZURE_DEFAULTS, AZURE_API_VERSION_RE, isAzureProvider, azureScope, ANTHROPIC_MAX_TOKENS, isAnthropicShape, anthropicBaseUrl, toAnthropicRequest, estimateTokens, SMALL_CONTEXT_WINDOW, recoverTextToolCalls, ChatMessage, ChatToolDef, ChatToolCall, CompletionRound, ToolCallingSupport, LlmModelInfo, LlmTestResult, normalizeBasePath, azureChatPath, chatCompletionsPath, parseAzureEndpoint, llmAuthHeaders, getAzureEntraToken, _clearEntraTokenCache, describeEndpoint, upstreamError, looksLikeEmbeddingModel, ollamaCapabilities, listModels, matchModelId, pickDefaultModel, probeToolCalling, testConnection, describeModels, resolveChatModel, _clearResolvedModelCache, applyStreamChunk, _clearTemperatureRefusals, chatCompletionRound.

**Cross-service deps:** none (utils/errors, utils/logger, utils/entraClientCredentials; npm `@anthropic-ai/sdk` + `@anthropic-ai/foundry-sdk` for the Claude shape).

**Used by:**
- src/services/assistantChatService.ts → streamAssistantTurn — every model round of a turn; estimateTokens for the context budget
- src/services/llmIntegrationService.ts → checkLlmToolCalling — listModels / matchModelId / pickDefaultModel / probeToolCalling
- src/api/routes/integrations.ts → POST /:id/test, POST /test — the llm branch of Test Connection
- src/services/discovery/discoveryEngine.ts → runPreflightTest — the 10-minute integrationConnectionTester re-test

**Invariants:**
- Speaks ONE dialect (OpenAI-compatible). Ollama-native `/api/chat` is not supported; Ollama's `/v1` is.
- The request timeout is an IDLE timeout (`req.setTimeout`), not a wall clock: a local model may take long to its first token and then stream for a long time.
- A 401/403 from the model server becomes "refused the API key" (Azure: worded by auth mode); nothing upstream is echoed beyond 300 characters.
- `apiToken` is sent as `Authorization: Bearer` only when set (most local servers need none); on Azure it is the `api-key` header and is never sent in Entra mode.
- The Entra access token and the client secret are never logged or put in an error message (`tests/unit/llmAzureFoundry.test.ts`).
- Every `integrationConnectionTester` tick (10 min) re-runs `testConnection`, so an enabled Azure integration makes one tiny billed chat call per tick.

**When changing this:**
- A new provider dialect is a new branch HERE, not in the chat service — the orchestrator only sees `chatCompletionRound`. Azure (rule 95(j)) is the worked example: path, auth headers, model discovery, Test Connection and error wording all dispatch on `isAzureProvider`.
- Keep `applyStreamChunk` tolerant: object-shaped `arguments`, missing `index`, `message` instead of `delta`.
- `tests/unit/llmService.test.ts` drives a real local HTTP server — extend it for any new parsing case.

---

## services/assistantToolService.ts

**What it owns:** The lookups the assistant may make, as OpenAI-style tool definitions plus their implementations: `search_help`, `search`, `fleet_summary`, `list_assets`, `get_asset`, `list_alerts`, `list_events`, `list_networks`, `list_reservations`, `create_report`. Every tool runs **as the caller** — it is handed the caller's own Express request and checks `hasPermission(req, key, "read")` before touching anything (rule 95(a)); alerts are region-scoped with the Alerts page's own predicate (`viewerRegionTags`, admin-equivalent unscoped). All tools are read-only (95(b)), project to a tight `select`, cap rows at the integration's `maxRowsPerTool`, and report `truncated`. `create_report` re-runs one list tool server-side with `REPORT_ROW_CAP` (5000) and hands the client a `{title, columns, rows}` table built from database rows, never model text (95(c)).

**Public API:** regionTagVariants, REPORT_ROW_CAP, ReportColumn, AssistantReportPayload, ToolContext, ToolResult, assistantToolDefs, toolLabel, runAssistantTool.

**Cross-service deps:** searchService (searchAll), notificationService (listNotifications — the `triggeredFrom`/`triggeredTo` window was added for correlation lookups), regionScopeService (getEffectiveRegionTags, getEffectiveTagScopes), eventLogService (queryEventsPage), eventArchiveService (getRetentionSettings — the events retention floor), helpIndexService (searchHelp), permissions.ts (hasPermission, callerIsAdminEquivalent), utils/cidr (usableHostCount, isValidCidr, ipInCidr).

**Used by:**
- src/services/assistantChatService.ts → streamAssistantTurn — tool definitions per round; runAssistantTool per tool call
- src/services/assistantConversationService.ts — the AssistantReportPayload type it persists

**Invariants:**
- `runAssistantTool` never throws: unknown tool, bad JSON, Zod failures and query errors come back as `{ ok: false, data: { error } }` so the model can recover.
- A role without the key gets "Not permitted" and NO query runs (pinned by `tests/unit/assistantToolService.test.ts`).
- `list_reservations` does NOT use `reservationService.listReservations` — that include carries the subnet integration's config (secrets) for the push UI.
- `list_assets` subnet filtering narrows in SQL to rows with an IP, then matches with `utils/cidr` (IP math lives only there).
- Decommissioned assets and deprecated (retired) networks are left OUT by default (owner's call, 2026-10-09): `list_assets` adds `status: { not: "decommissioned" }` unless a `status` filter is given, `list_networks` `status: { not: "deprecated" }` likewise, and `fleet_summary` counts no decommissioned asset. `search` and `get_asset` still find them — naming a device is asking for it. The system prompt says the same.
- `list_assets` `region` / `myRegions` match the region's asset tags through `regionTagVariants`: each name (any case, with or without `region:`) resolves case-insensitively against the Tag registry under both the `region:<name>` and the bare form, plus the literal forms (`utils/tagNormalize.REGION_TAG_PREFIX`) — the same tags alert scoping snapshots. Exact matching once reported a real Middle Tennessee device absent (2026-10-09), which is also why the system prompt now tells the model to check itself (region filter, then tag / location / search / list_alerts) before concluding something is absent, and to believe the person over one empty lookup; `myRegions` reads the caller's ASSIGNED regions (`getEffectiveTagScopes`, admins included) and refuses — without querying — when none is assigned, rather than answering for the whole install.
- Subnet utilization counts only active reservations holding an IP — business rule 69's numerator.

**When changing this:**
- A new tool needs: a permission check first, Zod args, a tight select, a row cap, a chip `label`, and — if it lists rows — `columns` + `rows()` so `create_report` can source it.
- Never add a tool that writes, acknowledges, pushes, probes or reads a secret (rule 95(b)); `credentials`, `apiTokens`, `users`, `roles`, `authentication`, `automationScripts` and server settings stay out.
- At 2000 assets the hot path is `list_assets` with a `subnet` filter (an in-memory CIDR pass over the matched set) — keep its `select` tight.

---

## services/assistantChatService.ts

**What it owns:** One streamed assistant turn: `beginTurn` (ownership + store the question, or drop the last answer for /retry) → emit `start` → system prompt + the last `contextMessages` turns → `chatCompletionRound` with the tool definitions → run each tool call as the caller and loop, up to `maxToolRounds` (capped at 12); the final round is offered NO tools so the model must answer → `finishTurn` saves the answer (partial + `stopped` on abort or mid-answer failure) and any report snapshots → one `assistant.chat` Event naming the lookups (never the question or answer text). Also resolves which `llm` integration answers (`resolveAssistantIntegration`) and lists them for the widget (names + models only).

**Fitting the context window (2026-10-07):** an overflowing prompt is not refused — the model server silently drops the OLDEST tokens, i.e. the system prompt and tool definitions, and the model loses the task. So each turn is budgeted from the integration's `contextWindow` (`contextBudget`): the prompt may use 60 %, one lookup result at most a quarter of the window in characters (clamped 1 500–24 000). `fitHistory` keeps the newest turns that fit after the instructions + tool list, always keeps the question (cut down if it alone overflows) and never opens on an orphaned answer; before every round `compactToolResults` replaces the OLDEST lookup results with a one-line `{"omitted":…}` note until the prompt fits, never the newest. `contextMessages` is still the upper bound on turns.

**Reasoning progress:** `onReasoning` from llmService becomes a `thinking { chars }` event — the total across rounds, at most every 400 ms. The widget turns it into "Reasoning… N characters · Ns" on the live line.

**What the model is told about the caller (2026-10-09):** `permissionsPromptBlock(roleSnapshot)` puts the caller's role name and every area they hold, with its level (Read / Read-Write / Full Read-Write, `subnets` worded as Networks), into the system prompt via `buildSystemPrompt({ access })`, so a how-to answer says whether the role allows it instead of hedging. Information only — every lookup is still checked in code (rule 95(a)). It costs a few hundred tokens a turn. `scopePromptBlock` adds the person's assigned regions and free-form scope tags (`regionScopeService.getEffectiveTagScopes`, fetched with the turn; a failure only drops the hint), so "my region" maps to `list_assets` `myRegions`.

**Public API:** AssistantEmit, AssistantIntegrationRef, ContextBudget, DEFAULT_IDLE_RESET_MINUTES, resolveAssistantIntegration, listAssistantIntegrations (names, models, displayName and `idleResetMinutes` — the widget's and phone's idle window), permissionsPromptBlock, scopePromptBlock, buildSystemPrompt, contextBudget, fitHistory, compactToolResults, streamAssistantTurn.

**Efficiency Advisor (rule 95(h), 2026-10-07; 95(k), 2026-10-09):** the voice is `advisorVoice(advisorOn, config.provider)` — `off`, `canned` (a local / OpenAI-compatible server: everything below) or `model` (Azure AI Foundry: `buildSystemPrompt({ persona: ADVISOR_PERSONA })` — on every turn, outages included: its outage rule forbids jokes about the devices or the outage and aims the character at the person — and NO preface / sign-off / `recentAdvisorLines` read). With the canned voice, when the caller's `User.assistantEfficiencyAdvisor` is on, the turn emits `preface { text }` as its FIRST tool call starts (before that tool's `tool` event), `preface { text: null }` to withdraw it if a lookup then shows an outage, and `signoff { text }` after the answer; both lines are stored on the AssistantMessage (`preface` / `signOff`), never in `content`. The signals (`TurnSignals`) are gathered by `noteLookup` per tool result whether or not the advisor is on. The model's system prompt carries NO persona — see efficiencyAdvisorService.

**Memory (rule 95(i), 2026-10-09):** when the caller's `User.assistantMemory` is on, the turn loads their entries (`listMemory`), adds `memoryPromptBlock` to the system prompt AFTER the operator's instructions (so `fitHistory` budgets it), and appends `remember` / `forget` to the tool list. A call to either goes to `assistantMemoryService.runMemoryTool` with a `MemoryTurn` holding THIS turn's question (what `remember` must be grounded in) — never to `runAssistantTool`, and with no Efficiency Advisor line or lookup signal. A successful change emits `memory { action, text }`. Memory off → no block, no tools; a memory call the model makes anyway reaches `runAssistantTool` and is answered "Unknown tool".

**Cross-service deps:** llmService (chatCompletionRound, estimateTokens, LLM_DEFAULTS), assistantToolService (assistantToolDefs, runAssistantTool, toolLabel), assistantConversationService (beginTurn, finishTurn, recentTurns, getEfficiencyAdvisor, recentAdvisorLines), assistantMemoryService (getMemoryEnabled, listMemory, memoryPromptBlock, memoryToolDefs, memoryToolLabel, runMemoryTool, MEMORY_TOOL_NAMES), efficiencyAdvisorService (asksAboutOutage, lookupShowsOutage, lookupFoundSomething, topicForTool, pickSignOff, pickLookupLine), eventLogService (logEvent), regionScopeService (getEffectiveTagScopes), permissions.ts (FUNCTION_KEYS, normalizePermissions, isAdminEquivalentPermissions).

**Used by:**
- src/api/routes/assistant.ts → GET /status (listAssistantIntegrations), POST /conversations/:id/messages (resolveAssistantIntegration + streamAssistantTurn)

**Invariants:**
- Never throws once streaming has started — failures become an `error` event; the route opens the SSE stream on `start`, i.e. only after ownership passed.
- An error before any text stores NOTHING for the answer (the question stays; /retry re-asks it).
- Tool results handed back to the model are clipped to `contextBudget(contextWindow).toolResultChars` — 24 000 characters at most, ~7 000 at the 8192 default.
- The model's reasoning text never leaves llmService; only its length reaches the client.
- The audit Event carries tool names, report count and stopped — the conversation text is the owner's data (rule 95(d)).
- **First-round steering** (2026-10-07, qwen2.5:7b): a message that plainly asks for a report (`asksForReport`) is offered ONLY `create_report` on round 0, and one that asks how to use / configure Polaris (`asksHowTo`, deliberately narrow — "how many…" is not) ONLY `search_help`. A report request that still ends without a report is turned into one from the model's last list lookup, same filters (`reportTitleFromQuestion`).
- **Links are checked** (`sanitizeAnswerLinks`, after the turn): only `WIKI_BASE_URL/<page>` for a page `helpIndexService.wikiPageNames()` knows, or a same-origin path. Anything else keeps its text and loses the link (a model invented `docs.polaris.example.com/subnets/add-subnet`); a changed answer is re-sent whole via `retract {from:0}` + `token`.
- **Turns outlive the page** (`registerTurn` / `releaseTurn` / `isTurnRunning` / `stopTurn`): the route does not abort on disconnect; Stop is `POST /conversations/:id/stop`; the next page sees `pending`.
- **Text after a report is HELD, then table-stripped** (`stripMarkdownTables`). The model only ever sees a report's row COUNT, so a table it types afterwards is invented — seen live 2026-10-07 (qwen2.5:7b re-typed a "report" of networks that do not exist beside the real card). Rounds after the first `create_report` are buffered instead of streamed, tables removed, and an all-table reply becomes `REPORT_READY_TEXT`. This is rule 95(c) enforced in code, not left to the prompt.

**When changing this:**
- The system prompt is the behavioural contract (tools for facts, search_help for how-to, create_report for downloads, read-only; since 2026-10-09 also: a how-to about ADDING something looks the named thing up BEFORE answering and opens with whether it exists, or says how to search and offers to search for them — a live answer had told someone how to add an asset without checking for it) — `tests/unit/assistantChatService.test.ts → buildSystemPrompt` pins its load-bearing lines.
- Changing the event vocabulary changes `public/js/assistant.js → ask()` in the same commit.

---

## services/assistantConversationService.ts

**What it owns:** The saved conversations (AssistantConversation / AssistantMessage / AssistantReport). Every function takes the session user's id and scopes every query to it — someone else's id answers 404 (rule 95(d)). List / create / get / rename / delete / clear; `beginTurn` / `finishTurn` / `recentTurns` for the chat service; the `assistant` Setting (`retentionDays`, default 90) and `pruneAssistantConversations` (rule 95(e)). Creating past 200 conversations for one user drops that user's oldest. `updateAssistantSettings(input, actor)` writes an `assistant.settings.updated` Event when the value changes — a warning when it shortens, because the next prune then deletes conversations. The operator edits it from the AI Assistant integration form ("Keep conversations for"), which calls PUT /assistant/settings after the integration saves; it stays a server-wide Setting, not integration config.

**Public API:** AssistantSettings, ToolUseRecord, getAssistantSettings, updateAssistantSettings, getEfficiencyAdvisor, setEfficiencyAdvisor, recentAdvisorLines, titleFromQuestion, listConversations, createConversation, getConversation, renameConversation, deleteConversation, clearConversation, recentTurns, beginTurn, finishTurn, pruneAssistantConversations.

**Cross-service deps:** eventLogService (logEvent — the retention change); otherwise Prisma only (the report payload type comes from assistantToolService).

**Used by:**
- src/api/routes/assistant.ts — every conversation route, PUT /settings, GET /status (getEfficiencyAdvisor) and PUT /preferences (setEfficiencyAdvisor)
- src/services/assistantChatService.ts — beginTurn / finishTurn / recentTurns / getEfficiencyAdvisor / recentAdvisorLines
- src/jobs/pruneEvents.ts — pruneAssistantConversations, hourly, in its own try

**Invariants:**
- Only user / assistant turns are stored; tool calls and results never are.
- Reports are snapshots — reopening a conversation downloads the figures the user saw.
- Pruning is one batched `deleteMany` on `updatedAt` (indexed); messages and reports cascade.
- `recentTurns` selects `role` + `content` only — the Efficiency Advisor's `preface` / `signOff` columns must never reach the model (it copies them; rule 95(h)).

**When changing this:**
- Any new read path MUST take `userId` and scope by it; there is no admin override by design.
- A schema change here is a migration + `polaris-domain-model/references/platform.md`.

---

## services/assistantMemoryService.ts

**What it owns:** The assistant's per-user memory (business rule 95(i), `AssistantMemoryEntry`): short sentences about the PERSON sent in every turn's system prompt. The `remember` / `forget` tool definitions and `runMemoryTool`, which the chat service calls with a per-turn `MemoryTurn`; the store (`listMemory` / `addMemory` / `deleteMemory` / `clearMemory`) behind the Memory drawer's routes; the per-user switch (`getMemoryEnabled` / `setMemoryEnabled`, `User.assistantMemory`, default on). Pure checks: `checkMemoryText` (no IP / CIDR / MAC via `utils/cidr`, no URL, nothing credential-shaped, no prompt-override phrasing, ≤200 chars), `groundedInMessage` (≥70 % of the fact's meaningful words, stemmed, appear in the user's message), `asksToForget`, `memoryPromptBlock` (numbered entries, framed as background, never instructions).

**Public API:** MEMORY_LIMITS, MemorySource, MemoryEntry, normalizeMemoryText, checkMemoryText, groundedInMessage, asksToForget, memoryPromptBlock, MEMORY_TOOL_NAMES, memoryToolDefs, memoryToolLabel, getMemoryEnabled, setMemoryEnabled, listMemory, addMemory, deleteMemory, clearMemory, MemoryTurn, runMemoryTool.

**Cross-service deps:** eventLogService (logEvent — `assistant.memory.added` / `.removed` / `.cleared`, never the text); utils/cidr (isValidIpAddress, isValidCidr).

**Used by:**
- src/services/assistantChatService.ts → streamAssistantTurn — the switch, the entries, the prompt block, the tool definitions, runMemoryTool per memory call
- src/api/routes/assistant.ts → GET /status, PUT /preferences, GET / POST / DELETE /memory, DELETE /memory/:id

**Invariants:**
- `remember` is refused unless `groundedInMessage(fact, turn.question)` — text from a lookup result never reaches memory. This is the guard; the prompt wording is not.
- `checkMemoryText` runs inside `addMemory`, so the user's own writes pass the same filter as the model's.
- The tools take NO user id; `MemoryTurn.userId` comes from the session. Every store query is scoped by `userId`; a foreign id is a 404.
- `runMemoryTool` never throws — refusals come back `{ ok: false, data: { error } }` for the model to relay.
- At most one `remember` and one `forget` per turn; 25 entries and 2000 characters per user (`MEMORY_LIMITS`).

**When changing this:**
- Loosening `groundedInMessage` or `asksToForget` widens the prompt-injection path rule 95(i) closes — pin any change with a poisoned case in `tests/unit/assistantMemoryService.test.ts`.
- A new memory source (a nightly distil, an import) must not write text the user did not type that turn; see the rejected alternatives in narrative-95.md § (i).
- Event vocabulary changes go to `public/js/assistant.js → ask()` in the same commit.

---

## services/efficiencyAdvisorService.ts

**What it owns:** The assistant's optional "Efficiency Advisor" (business rule 95(h)) — shown to users as **R.A.L.P.H.** since 2026-10-09: the chat-window checkbox label, its hover title "Real-time Assesser of Labor and Productivity Habits" (the owner's exact wording), the greeting / farewell lines and `ADVISOR_PERSONA` all use that name, while code, the `User.assistantEfficiencyAdvisor` column and the rules keep "Efficiency Advisor" — a per-user chat-window checkbox that adds canned lines in the voice of a patronizing productivity AI: one from `LOOKUP_LINES` when a turn's first lookup starts, and one from `SIGN_OFFS` under the answer. Pure logic, no I/O: `pickCategory(TurnSignals)` maps what the turn did to a category (`attitude` on a "Not permitted" lookup or a complaining question, `pepTalk` on a frustrated one, `helpAnswered` after search_help, `congratulation` / `backToWork` after a lookup that found something / nothing, `funDetected` with no lookup) `letDown` on an outage, or to null on a failed / stopped turn; `pickSignOff` / `pickLookupLine` choose a line, skipping the conversation's recent ones while others are left, and fill `{topic}` from `topicForTool`. `asksAboutOutage` (question) and `lookupShowsOutage` (tool JSON: a `down`/`critical` status or severity, or a non-zero `down`/`critical` count) gate it.

**Public API:** SignOffCategory, SIGN_OFFS, LOOKUP_LINES, AdvisorVoice, advisorVoice, advisorLeads, _setAdvisorPlacementRand, ADVISOR_PERSONA, TurnSignals, asksAboutOutage, lookupShowsOutage, lookupFoundSomething, topicForTool, pickCategory, pickSignOff, pickLookupLine.

**Cross-service deps:** none.

**Used by:**
- src/services/assistantChatService.ts → streamAssistantTurn — the preface on the first tool call, the signals per lookup, the sign-off after the answer

**Invariants:**
- On a LOCAL model server POLARIS picks every line and the model never sees the persona (on Azure AI Foundry the model plays it — rule 95(k); `ADVISOR_PERSONA` wording is owner-reviewed text like the lines). Asked to play it via the system prompt (2026-10-07, qwen2.5:7b), the model parroted one sample line on every answer, quipped under a critical device-down alert, and — pushed harder — skipped its lookups and invented an IP and a network count. Do not move the LOCAL voice back into the prompt.
- ONE canned line per turn (2026-10-09): `advisorLeads()` flips a coin — heads, the before-lookup line leads at the first tool call and the sign-off is skipped; tails, no preface and the sign-off closes. A turn that runs no lookup can only close. `_setAdvisorPlacementRand` pins the coin in tests (the integration test pins it to close).
- No line on an error or a Stop. On an outage (question or lookup) the sign-off comes from `letDown` — lines at the PERSON's expense that never mention a device (pinned by `efficiencyAdvisorService.test.ts`); the before-lookup line is shown and kept (owner's call, 2026-10-09).
- The loading-screen lines ("Dividing by zero…") that replace "Thinking…" while an advisor user waits are CLIENT-ONLY: `public/js/assistant.js → LOADING_LINES` / `startLoadingLines()`, cycled every 2.2 s until the first token, never sent anywhere or stored. Ticking the box also posts one of `ADVISOR_GREETINGS` (unticking, one of `ADVISOR_FAREWELLS`) as a local note (dashed bubble, like `/help` output) — likewise client-only and unsaved.
- "pioneer" from the source quotes is "engineer" here; the line lists were reviewed and chosen by the owner — add or change a line only with their review.

**When changing this:**
- A new tool that returns rows should get a `TOOL_TOPICS` noun, or `{topic}` lines never fire after it.
- A tool whose result names a down state under a new key needs `lookupShowsOutage` widened, or a quip lands under an outage.
- **Deliberately undocumented for operators (owner's call, 2026-10-07):** the Efficiency Advisor is an easter egg. Do NOT add it to `README.md` or to any `docs/wiki/` page, and `/polaris-docs-sync` should not route it there — this entry, rule 95(h) and the domain-model notes are its only documentation.

---

## services/assistantPlaybookService.ts

**What it owns:** The assistant's playbooks (2026-10-09): procedures for the multi-step NOC questions the tool layer cannot encode — `correlate` (why did X go down: device → alerts in the window, with and without the device filter → events → the upstream parent → timeline, then the cause only if the data supports it), `changed` (what changed since: events by kind, alerts opened/cleared, assets whose state moved, headline counts first), `health` (is X ok: get_asset, 24 h of alerts and events, a one-line verdict first) and `capacity` (networks ≥ 80 % fullest first, then addresses held by devices not seen in a month). `pickPlaybook(question)` matches by regex, first match wins. Each playbook supplies `guidance` (the numbered procedure, ending with "keep what the data shows apart from what you infer") and `firstRoundTools`.

**Public API:** AssistantPlaybook, PLAYBOOKS, pickPlaybook.

**Cross-service deps:** none (pure).

**Used by:**
- src/services/assistantChatService.ts → streamAssistantTurn — the guidance rides as a SECOND leading system message for the turn (a Claude deployment folds it into `system`; an OpenAI server sees two system messages) and `firstRoundTools` are the only tools offered on round 0, every tool again from round 1 — the same steering `asksForReport` / `asksHowTo` do, which keep priority. The audit Event carries `details.playbook`.

**Invariants:**
- A playbook changes the ORDER of lookups, never what a lookup may see — every tool still runs as the caller (rule 95(a)).
- Every tool a playbook names exists (`tests/unit/assistantPlaybookService.test.ts` checks the first-round set and the procedure text against `assistantToolDefs()`).

**When changing this:**
- A new playbook needs a matcher that does not catch a how-to ("how do I correlate…" is a help question first) or a report request, and a chat-service test that its tools land on round 0 (`assistantChatService.test.ts → playbooks steer round 0`).
- The guidance is prompt text: keep it a numbered procedure with tool names and argument names the tools really take (`hours`, `since`/`until`, `sortBy`, `minUtilizationPercent`, `notSeenForHours`).

---

## services/helpIndexService.ts

**What it owns:** Keyword search over the operator wiki (`docs/wiki/*.md`) for the `search_help` tool. Reads the folder once per process, lazily; splits each page at `##` / `###` headings (never at a `#` inside a code fence); ranks sections BM25-style with a heading boost; returns at most 5 sections under a 6 KB budget, each with its GitHub wiki URL (`WIKI_BASE_URL`, the same base as the Help menu's `WIKI_URL` in `public/js/app.js`) and anchor. A missing folder answers `available: false`.

**Public API:** WIKI_BASE_URL, HelpSection, HelpHit, HelpSearchResult, tokenize, wikiAnchor, splitWikiPage, buildHelpIndex, rankHelp, searchHelp, _resetHelpIndexForTests.

**Cross-service deps:** none (node:fs).

**Used by:**
- src/services/assistantToolService.ts → search_help

**Invariants:**
- The path is resolved relative to the module (`../../docs/wiki`) so it is the same from `src/services` and `dist/services`.
- The Docker image must `COPY docs/wiki` (Dockerfile); RHEL installs are a git tree and already have it.
- `_Sidebar`, `_Footer` and `README` are skipped — navigation chrome, not documentation.

**When changing this:**
- If `WIKI_URL` in `public/js/app.js` moves, move `WIKI_BASE_URL` with it.
- Embedding-based retrieval would be a new dependency and a model call per question — the keyword index is deliberate.

---

## services/llmIntegrationService.ts

**What it owns:** The role + API token an llm integration provisions for its model server (rule 95(f)). `provisionLlmAccess` creates a custom role `llm-<name>` with `botPermissions()` — read on every key whose ladder has a read rung, except `BOT_EXCLUDED_KEYS` (credentials, apiTokens, users, roles, authentication, automationScripts, serverSettingsSystem, serverSettingsData, assistant) — then mints an API token bound to it and returns the raw token once; a token failure deletes the role. `assertCanProvision` requires `roles` write AND `apiTokens` write (and runs `assertNoPrivilegeEscalation`). `regenerateLlmToken` deletes the old token and mints a new one on the same role. `deprovisionLlmAccess` deletes the token then the role (role FK is Restrict), best-effort per step. `checkLlmToolCalling` (2026-10-07) runs `probeToolCalling` against the model a SAVED integration will chat with — the configured one under the server's own name, or `pickDefaultModel` for a blank Model — and stamps `config.toolCheck = { model, result, at }` (re-reading config just before the write so an edit saved during the up-to-90 s probe survives) plus an `integration.llm.tool_check` Event (warning on `no`). An unreachable server throws and stores nothing. The form fires it after every create / save; the card's Tool Calling row reads it. On an Azure AI Foundry integration (rule 95(j)) it skips `listModels` and probes the configured deployment as-is (409 when Model is blank).

**Public API:** BOT_EXCLUDED_KEYS, botPermissions, botRoleBaseName, assertCanProvision, ProvisionResult, provisionLlmAccess, regenerateLlmToken, LlmToolCheck, checkLlmToolCalling, deprovisionLlmAccess.

**Cross-service deps:** roleService (createRole, deleteRole), apiTokenService (createToken, deleteToken), llmService (isAzureProvider, listModels, matchModelId, pickDefaultModel, probeToolCalling), eventLogService (logEvent), permissions.ts (FUNCTION_KEYS, keySupportsLevel, hasPermission, assertNoPrivilegeEscalation).

**Used by:**
- src/api/routes/integrations.ts → POST / (assertCanProvision before the row; provisionLlmAccess after, rolling the row back on failure), DELETE /:id (deprovisionLlmAccess), POST /:id/llm/regenerate-token, POST /:id/llm/check-tools

**Invariants:**
- The bot role never writes and is never admin-equivalent (`tests/unit/assistantRbacLockstep.test.ts`).
- The in-app chat NEVER uses this token — chat lookups run as the chatting user; the token is only for the model host's own direct API calls.
- `roleId` / `roleName` / `tokenId` / `toolCheck` live in `Integration.config` and are server-stamped (`LLM_SERVER_KEYS` in the route); the PUT path re-attaches them from the stored row. `toolCheck` is DROPPED instead when the PUT moves `provider`, `host`, `port`, `basePath`, `useHttps`, `model` or `azureApiShape` — a verdict describes one model on one server. An absent `provider` / `azureApiShape` (a row saved before Azure support) compares as its default, so a plain save of such a row keeps its verdict.

**When changing this:**
- A new function key: decide whether the bot should read it, and add it to `BOT_EXCLUDED_KEYS` if it exposes secrets, identities or administration.
- Existing bot roles are NOT updated when a key is added later — they get `none` from `normalizePermissions`; an operator widens them by hand under Users → Roles.
