/**
 * src/services/assistantChatService.ts — one assistant turn, streamed
 * (business rule 95).
 *
 *   1. beginTurn stores the user's question (or, for /retry, drops the last
 *      answer) — ownership is checked there.
 *   2. The last N turns + a system prompt go to the `llm` integration's
 *      OpenAI-compatible endpoint with the assistant tool definitions —
 *      trimmed to fit the integration's contextWindow (contextBudget).
 *   3. Text streams straight to the caller as `token` events. When the model
 *      asks for tools, each runs AS THE CALLER (assistantToolService) and the
 *      results go back for another round, up to maxToolRounds; the last round
 *      is offered no tools so the model has to answer.
 *   4. finishTurn stores the answer — whole, or partial with stopped=true when
 *      the client hung up — together with any report snapshots.
 *
 * Events emitted to the caller (the route turns them into SSE frames):
 *   start  { question }                  ownership passed, question stored
 *   token  { text }                      a slice of the answer
 *   retract { from }                     drop the answer text from char `from` on —
 *                                        a tool call the model wrote as text, now run
 *   thinking { chars }                   a thinking model's reasoning so far (length
 *                                        only, never the text), at most every 400 ms
 *   tool   { name, label, status, ok? }   status: "running" | "done"
 *   report { id?, title, columns, rows, rowCount, truncated }
 *   memory { action, text }              remember/forget changed the caller's memory (rule 95(i))
 *   done   { messageId, stopped }
 *   error  { message }
 */

import { trimTrailing } from "../utils/trimTrailing.js";
import type { Request } from "express";
import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { logEvent } from "./eventLogService.js";
import {
  chatCompletionRound,
  resolveChatModel,
  recoverTextToolCalls,
  estimateTokens,
  acceptsImages,
  LLM_DEFAULTS,
  type ChatMessage,
  type LlmConfig,
} from "./llmService.js";
import {
  assistantToolDefs,
  runAssistantTool,
  toolLabel,
  REPORT_SOURCE_NAMES,
  WINDOW_OPTIONAL_TOOLS,
  type AssistantReportPayload,
  type ReportFormat,
} from "./assistantToolService.js";
import {
  beginTurn,
  finishTurn,
  recentTurns,
  loadTurnImages,
  getEfficiencyAdvisor,
  recentAdvisorLines,
  type ToolUseRecord,
} from "./assistantConversationService.js";
import { WIKI_BASE_URL, wikiPageNames } from "./helpIndexService.js";
import { FUNCTION_KEYS, normalizePermissions, isAdminEquivalentPermissions } from "../api/middleware/permissions.js";
import { getEffectiveTagScopes } from "./regionScopeService.js";
import { pickPlaybook } from "./assistantPlaybookService.js";
import {
  getMemoryEnabled,
  listMemory,
  memoryPromptBlock,
  memoryToolDefs,
  memoryToolLabel,
  runMemoryTool,
  MEMORY_TOOL_NAMES,
  type MemoryTurn,
} from "./assistantMemoryService.js";
import {
  asksAboutOutage,
  lookupShowsOutage,
  lookupFoundSomething,
  topicForTool,
  pickSignOff,
  pickLookupLine,
  advisorLeads,
  advisorVoice,
  ADVISOR_PERSONA,
  type TurnSignals,
} from "./efficiencyAdvisorService.js";

export type AssistantEmit = (event: "start" | "token" | "retract" | "thinking" | "tool" | "report" | "preface" | "signoff" | "memory" | "done" | "error", data: unknown) => void;

/** Ceiling on one tool result handed back to the model (characters of JSON); contextBudget sizes it down for small windows. */
const TOOL_RESULT_MAX_CHARS = 24_000;

export interface AssistantIntegrationRef {
  id: string;
  name: string;
  config: LlmConfig;
}

/**
 * The enabled `llm` integration to answer with: the requested one when it is
 * an enabled llm integration, else the oldest enabled one. Null when the
 * install has none — the widget is hidden in that case.
 */
export async function resolveAssistantIntegration(requestedId?: string): Promise<AssistantIntegrationRef | null> {
  const rows = await prisma.integration.findMany({
    where: { type: "llm", enabled: true },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, config: true },
  });
  const pick = (requestedId && rows.find((r) => r.id === requestedId)) || rows[0];
  return pick ? { id: pick.id, name: pick.name, config: pick.config as unknown as LlmConfig } : null;
}

/** Public list for GET /assistant/status — names and models only, never config. */
/** Default minutes a conversation may sit idle before the chat window sets it aside (0 = never). */
export const DEFAULT_IDLE_RESET_MINUTES = 30;

export async function listAssistantIntegrations(): Promise<Array<{ id: string; name: string; model: string; displayName: string; idleResetMinutes: number; images: boolean }>> {
  const rows = await prisma.integration.findMany({
    where: { type: "llm", enabled: true },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, config: true },
  });
  // A blank Model is shown as "auto" — the server's default pick at chat time.
  return rows.map((r) => {
    const c = (r.config as Record<string, unknown>) || {};
    return {
      id: r.id,
      name: r.name,
      model: String(c.model || "auto"),
      displayName: String(c.displayName || "").trim() || "Assistant",
      // How long the chat window waits before setting an idle conversation
      // aside and starting fresh (the widget and the phone read it; 0 = never).
      idleResetMinutes: typeof c.idleResetMinutes === "number" && c.idleResetMinutes >= 0
        ? c.idleResetMinutes : DEFAULT_IDLE_RESET_MINUTES,
      // Whether the chat window takes a pasted screenshot for this model (rule 95(l)).
      images: acceptsImages(c as Pick<LlmConfig, "provider" | "azureApiShape" | "acceptsImages">),
    };
  });
}

// ─── Turns in flight ─────────────────────────────────────────────────────────
//
// Every app page is its own document, so changing page drops the browser's
// stream. A turn must not die with it: the route no longer aborts on a
// client disconnect, the answer is finished and stored, and the next page
// sees `pending: true` on the conversation and waits for it. Stop is an
// explicit request (stopTurn). In-process state — the web role is a single
// replica; a restart mid-turn loses that turn, and its question stays
// stored for /retry.

const runningTurns = new Map<string, { controller: AbortController; userId: string; startedAt: number }>();

/** Claim the conversation for one turn. 409 while another is still running. */
export function registerTurn(conversationId: string, userId: string): AbortController {
  if (runningTurns.has(conversationId)) {
    throw new AppError(409, "Still answering your previous question in this conversation — wait for it, or press Stop");
  }
  const controller = new AbortController();
  runningTurns.set(conversationId, { controller, userId, startedAt: Date.now() });
  return controller;
}

export function releaseTurn(conversationId: string, controller: AbortController): void {
  if (runningTurns.get(conversationId)?.controller === controller) runningTurns.delete(conversationId);
}

/** Is a turn still being answered (for GET /conversations/:id `pending`)? */
export function isTurnRunning(conversationId: string): boolean {
  return runningTurns.has(conversationId);
}

/** Stop the caller's own running turn. False when nothing was running. */
export function stopTurn(conversationId: string, userId: string): boolean {
  const t = runningTurns.get(conversationId);
  if (!t || t.userId !== userId) return false;
  t.controller.abort();
  return true;
}

/** Fold one lookup's result into the turn's Efficiency Advisor signals. */
function noteLookup(s: TurnSignals, name: string, result: { ok: boolean; data: unknown }, json: string): void {
  if (name === "search_help") { s.usedHelp = true; return; }
  s.lookedUp = true;
  if (!result.ok) {
    const error = (result.data as { error?: unknown } | null)?.error;
    if (typeof error === "string" && error.startsWith("Not permitted")) s.denied = true;
    return;
  }
  if (lookupShowsOutage(json)) s.outage = true;
  if (lookupFoundSomething(result.data)) s.found = true;
  s.topic = topicForTool(name) ?? s.topic;
}

const LEVEL_WORDS: Record<string, string> = { read: "Read", write: "Read-Write", fullwrite: "Full Read-Write" };
// The matrix calls networks "Subnets"; every screen says Networks (and the prompt forbids "subnet").
const KEY_WORDS: Record<string, string> = { subnets: "Networks" };

/**
 * What the person asking may do, for the system prompt: their role and every
 * area they have access to, so a how-to answer can say "your role can do
 * this" instead of "if you get Not permitted, ask an admin". Informational
 * only — every lookup is still checked against the role in code (rule
 * 95(a)); a model that misreads this list cannot read or change more.
 * Null when the request carries no role. Exported for tests.
 */
export function permissionsPromptBlock(snap: { name?: string; permissions?: unknown } | null | undefined): string | null {
  if (!snap) return null;
  const perms = normalizePermissions(snap.permissions);
  const granted = FUNCTION_KEYS
    .filter((k) => perms[k.key] && perms[k.key] !== "none")
    .map((k) => `${KEY_WORDS[k.key] ?? k.label}: ${LEVEL_WORDS[perms[k.key]] ?? perms[k.key]}`);
  return [
    `The person's role is "${snap.name ?? "unknown"}"${isAdminEquivalentPermissions(perms) ? " (an administrator role)" : ""}. ` +
      "Their access, by area (Read = view; Read-Write = create and change; Full Read-Write = also other people's rows and deletes):",
    granted.length ? granted.join("; ") + "." : "No access to any area.",
    "Any area not listed is No access. When they ask how to do something, say plainly whether their role allows it " +
      "from this list — do not hedge with \"if you get Not permitted\". If it does not, say which access they would " +
      "need and that an administrator can grant it under Users → Roles.",
  ].join("\n");
}

/**
 * The person's scope, for the system prompt: the regions and free-form scope
 * tags assigned to them (role + account + sign-in groups), so "my region"
 * means something. The lookups do the narrowing — list_assets `myRegions`
 * reads the same assignment server-side — so this text only tells the model
 * what to ask for and how to word the answer. Exported for tests.
 */
export function scopePromptBlock(scope: { regions: string[]; tags: string[] } | null | undefined): string | null {
  if (!scope) return null;
  const lines: string[] = [];
  if (scope.regions.length) {
    lines.push(
      `The person's regions: ${scope.regions.join(", ")}. "My region", "my sites" and similar mean these: ` +
        "use list_assets with myRegions: true (or region: [names]) and say which regions the answer covers.",
    );
  } else {
    lines.push("No region is assigned to this person. If they ask about \"my region\", ask which region they mean.");
  }
  if (scope.tags.length) lines.push(`Their other scope tags: ${scope.tags.join(", ")}.`);
  return lines.join("\n");
}

/** The system prompt. Exported for tests. */
export function buildSystemPrompt(opts: { username?: string; now?: Date; extra?: string; displayName?: string; persona?: string; memory?: string; access?: string | null }): string {
  const now = opts.now ?? new Date();
  const name = opts.displayName?.trim();
  const lines = [
    (name ? `Your name is ${name}. ` : "") +
    "You are the Polaris assistant, built into Polaris — a monitoring and asset management tool " +
      "that monitors network devices and servers, raises alerts through automations, and keeps one multi-source " +
      "asset record per device, built from integrations such as FortiManager/FortiGate, Entra ID/Intune, Active " +
      "Directory, Windows DHCP, vCenter, Azure Arc, Unraid, TrueNAS, Proxmox VE and Generic API feeds. It also " +
      "keeps an IP address registry (blocks, networks, reservations).",
    `Current time: ${now.toISOString()} (UTC).${opts.username ? ` You are talking to ${opts.username}.` : ""}`,
    "",
    "How to work:",
    "- Talk naturally. Small talk and follow-up questions are fine; earlier turns are context.",
    "- Any fact about THIS install (devices, alerts, networks, events, counts, times) must come from a tool. " +
      "Never invent hostnames, IPs, counts or timestamps. If the tools return nothing, say so.",
    "- For questions about how to use, configure or troubleshoot Polaris, call search_help first and answer ONLY " +
      "from what it returns, linking the page with the exact url it gave, as [Page — Section](url). Never make up a " +
      "link, a page, a button or a menu. If the help has nothing, say you are not sure.",
    "- When the how-to is about ADDING something (an asset, a network, a reservation, a block…), do two more " +
      "things after the help lookup. If the person named the thing (a hostname, IP, MAC, CIDR or name), look it " +
      "up (search, list_assets, list_networks, list_reservations) BEFORE answering and open with whether it " +
      "already exists — if it does, say where, and say the add would be a duplicate. If they did not name it, " +
      "say how to check it is not already there before adding (the search bar at the top; for an asset, the " +
      "panel under + Add Asset that checks the IP as it is typed) AND offer to do the search for them — \"or " +
      "tell me the name or IP and I will check\". Never imply someone is about to create a duplicate unless a " +
      "lookup showed one.",
    "- Use the names Polaris shows on screen. Sidebar: Dashboard, Device Map, Application Map, Path Monitor, IPAM, " +
      "Assets, Events, Automations, Integrations, Users, Server Settings. IPAM has two tabs, IP Blocks (+ Add Block) " +
      "and Networks (+ Add Network). Never call a network a \"subnet\" — no screen in Polaris uses that word.",
    "- When a tool answers 'Not permitted', tell the user their role does not allow that; do not try to work around it.",
    "- To correlate an issue, look at the device (get_asset), then what else alerted or changed state in the same " +
      "time window (list_alerts / list_events with hours or since/until), and the upstream device it depends on. " +
      "Separate what the data shows from what you infer.",
    "- When the user asks for a report, export, list to download, or spreadsheet, call create_report with the " +
      "right source and filters, and formats set to the ones the user named (e.g. [\"pdf\"]) when they named any. " +
      "The user sees the finished table with download buttons; you do not see its rows, " +
      "so never type a table or rows for it — reply with one sentence naming what it holds.",
    "- CPU and memory figures (highest, lowest, average, peak, over a period) come from telemetry_summary, which " +
      "takes the same device filters as list_assets; a report of them is create_report with source " +
      "telemetry_summary. Never estimate a percentage yourself.",
    (opts.memory
      ? "- Apart from your memory of the user, you can only look things up. "
      : "- You can only look things up. ") +
      "You cannot change, acknowledge, push or delete anything in Polaris; if asked, explain where " +
      "in Polaris the user can do it.",
    "- Keep answers concise. Use short Markdown tables for up to ~15 rows; offer a report for more.",
    "- Check yourself before concluding something is absent or zero. A region (e.g. \"Middle Tennessee\") is found " +
      "with list_assets region: [name] — never with location or search, which do not read region tags. If a lookup " +
      "comes back empty for something the person named, try the other ways it could be recorded (region, tag, " +
      "location, search, list_alerts) before answering, and say what you tried. If the person says it exists, " +
      "believe them over one empty lookup and keep looking.",
    "- A device may have HELD an address it no longer shows as its IP (a WAN, secondary or former address). " +
      "search marks such a hit matchedOn: \"ipHistory\" with heldThisAddress, and get_asset returns ipHistory. " +
      "That device IS the answer for that address: say it held it, from which source and when it was last seen " +
      "there. Never dismiss such a hit as a text match.",
    "- When you name an asset that a lookup returned, link the name to its details as " +
      "[hostname](/assets.html#view=asset:ID) using the id field from that lookup — never a guessed or " +
      "remembered id. Only assets are linked this way.",
    "- Leave decommissioned assets and deprecated (retired) networks out of answers and reports unless the person " +
      "asks about them — the lookups already omit them unless their status is asked for.",
    "- Never mention your tools or their names (list_assets, create_report, …) to the user — say what you looked " +
      "up in plain words (\"I checked the networks\").",
  ];
  // The Efficiency Advisor persona (rule 95(k)): only on a hosted model, only
  // for a user who ticked it, never on a turn about an outage. Before the
  // operator's instructions, so those still have the last word.
  if (opts.access) lines.push("", opts.access);
  if (opts.persona?.trim()) lines.push("", opts.persona.trim());
  if (opts.extra?.trim()) lines.push("", "Operator instructions:", opts.extra.trim());
  // Rule 95(i): the person's memory, framed as background about them — after
  // the operator's instructions so it can never read as overriding them.
  if (opts.memory) lines.push("", opts.memory);
  return lines.join("\n");
}

/**
 * Is this a "how do I use / configure Polaris" question? Narrow on purpose:
 * "how many…" and "what's down" are data questions and do not match. A hit
 * offers ONLY search_help on the first round — left to choose, a small model
 * answers from general knowledge (seen live 2026-10-07: "how do I add a new
 * IP block" → steps through a "Subnets section" Polaris does not have, and a
 * docs URL that does not exist). Exported for tests.
 */
export function asksHowTo(text: string): boolean {
  const t = text.trim();
  if (/^using the polaris help documentation/i.test(t)) return true; // /docs
  return /\b(how (do|can|should|would) (i|we|you)|how to|where (do|can|is|are|would) |steps to|walk me through|what does .{1,40} mean|is it possible to|configure|set up|setup)\b/i.test(t);
}

/**
 * Links in an answer may only go to a real help page (WIKI_BASE_URL/<page>
 * for a page this install ships) or to a path inside Polaris. Anything else —
 * an invented docs site, a guessed wiki page — keeps its text and loses the
 * link; a bare URL of that kind is dropped. Exported for tests.
 */
export function sanitizeAnswerLinks(text: string, wikiPages: ReadonlySet<string>, assetIds?: ReadonlySet<string>): string {
  const allowed = (url: string): boolean => {
    const u = url.trim();
    // An asset-details link may only name an id a lookup returned THIS turn:
    // a model cannot be allowed to link a guessed or remembered id.
    const asset = /^\/assets\.html#view=asset:([^&\s)]+)/.exec(u);
    if (asset && assetIds) return assetIds.has(decodeURIComponent(asset[1]));
    if (/^\/(?!\/)/.test(u)) return true;
    if (!u.startsWith(WIKI_BASE_URL + "/")) return false;
    const page = decodeURIComponent(u.slice(WIKI_BASE_URL.length + 1).split(/[#?]/)[0]);
    return wikiPages.has(page);
  };
  let out = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => (allowed(url) ? m : label));
  out = out.replace(/(^|[\s(<])(https?:\/\/[^\s<>)\]]+)/g, (m, lead, url) => (allowed(url) ? m : lead.trimEnd()));
  return out;
}

/** The list tools a report can be built from (create_report's `source`). */
const REPORT_SOURCES: ReadonlySet<string> = new Set(REPORT_SOURCE_NAMES);

/**
 * Does this message plainly ask for a downloadable report? Deliberately
 * narrow — a false hit only means the first round is offered create_report
 * alone. `/report` arrives as "Create a downloadable report: …". Exported for tests.
 */
export function asksForReport(text: string): boolean {
  const t = text.trim();
  // "How do I export…", "where is the report…" are help questions, not requests.
  if (/^(how|where|why|when|what is|what's|what are|can i|could i|is there|does|do you)\b/i.test(t)) return false;
  if (/\b(report|reports|export|download|downloadable|spreadsheet|csv|pdf|excel|xlsx)\b/i.test(t)) return true;
  // A making-verb before a mistyped "report" ("create a reported of…", seen
  // live 2026-10-26) — the verb keeps "which devices reported errors" out.
  return /\b(create|make|build|generate|run|pull|produce|give me)\b.{0,20}\breport\w*/i.test(t);
}

/**
 * The download formats a message names — "a PDF of the switches" offers the
 * PDF alone. Empty when it names none (the card then offers all three).
 * Exported for tests.
 */
export function reportFormatsFromQuestion(text: string): ReportFormat[] {
  const out: ReportFormat[] = [];
  if (/\bcsv\b|\bspreadsheet\b|\bexcel\b|\bxlsx\b/i.test(text)) out.push("csv");
  if (/\bpdfs?\b/i.test(text)) out.push("pdf");
  if (/\bmarkdown\b|\.md\b/i.test(text)) out.push("md");
  return out;
}

/** A report title from the question that asked for it. Exported for tests. */
export function reportTitleFromQuestion(text: string): string {
  const t = trimTrailing(text
    .replace(/^\s*(create a downloadable report:\s*)/i, "")
    .replace(/^\s*(please\s+)?(can you\s+|could you\s+)?(give me|make|build|create|generate|export|download|show me)?\s*(me\s+)?(a\s+|an\s+|the\s+)?(downloadable\s+)?(pdf\s+|csv\s+|markdown\s+)?(report|export|spreadsheet|csv|pdf)?\s*(of|on|for|about|with)?\s*/i, "")
    .replace(/^(the|a|an|all)\s+/i, ""), "?.!")
    .trim();
  if (!t) return "Report";
  const title = t.charAt(0).toUpperCase() + t.slice(1);
  return title.length > 80 ? title.slice(0, 77).trimEnd() + "…" : title;
}

/** What the reply says when, after a report, the model said nothing BUT a table. */
const REPORT_READY_TEXT = "The report is ready — preview and download it below.";

/**
 * Remove Markdown pipe tables (a header line, a `|---|` separator, its rows)
 * from model text, keeping the prose around them. Used on text written after
 * a report was built, where any table is invented. Exported for tests.
 */
export function stripMarkdownTables(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const sep = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("|") && i + 1 < lines.length && sep.test(lines[i + 1])) {
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) i++;
      i--;
      continue;
    }
    out.push(lines[i]);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function isAbort(err: unknown, signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted) || (err as { name?: string })?.name === "AbortError";
}

function clipJson(value: unknown, maxChars: number): string {
  const s = JSON.stringify(value);
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars) + '…"(truncated — narrow the filters or use create_report)"';
}

// ─── Fitting the model's context window ──────────────────────────────────────
//
// A local model's window is small (Ollama defaults to 4096 tokens) and a
// prompt that overflows it is not refused — the server silently drops the
// OLDEST tokens, which is the system prompt and the tool definitions, and the
// model then loses the task (seen live 2026-10-07: minutes of silent
// reasoning). So the turn is budgeted against the integration's
// `contextWindow`: the instructions + tool list + conversation may use 60 %,
// a lookup result at most a quarter, and the rest is left for the answer.

const TOOL_RESULT_MIN_CHARS = 1_500;

export interface ContextBudget {
  window: number;
  /** Tokens the prompt (system + tools + history + this turn's lookups) may use. */
  promptTokens: number;
  /** Characters one lookup result may carry back to the model. */
  toolResultChars: number;
}

/** The budget for a window of `contextWindow` tokens. Exported for tests. */
export function contextBudget(contextWindow: number | undefined): ContextBudget {
  const w = Math.min(Math.max(Math.floor(contextWindow ?? LLM_DEFAULTS.contextWindow), 2048), 1_000_000);
  return {
    window: w,
    promptTokens: Math.floor(w * 0.6),
    toolResultChars: Math.min(TOOL_RESULT_MAX_CHARS, Math.max(TOOL_RESULT_MIN_CHARS, Math.floor(w * 3.5 * 0.25))),
  };
}

/**
 * The newest turns that fit `budgetTokens` after the fixed part of the prompt
 * (instructions + tool definitions). The latest turn — the question being
 * answered — is always kept, cut down if it alone is too long. Exported for tests.
 */
export function fitHistory<T extends { role: "user" | "assistant"; content: string; extraTokens?: number }>(
  fixedTokens: number,
  turns: T[],
  budgetTokens: number,
): T[] {
  if (!turns.length) return turns;
  let room = Math.max(budgetTokens - fixedTokens, 0);
  const kept: T[] = [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    const cost = estimateTokens(t.content) + 4 + (t.extraTokens ?? 0);
    if (i === turns.length - 1) {
      // Never drop the question itself; trim it to what is left if it must be.
      const maxChars = Math.max(Math.floor(room * 3.5), 200);
      kept.unshift(t.content.length > maxChars ? { ...t, content: t.content.slice(0, maxChars) + "…" } : t);
      room -= Math.min(cost, room);
      continue;
    }
    if (cost > room) break;
    kept.unshift(t);
    room -= cost;
  }
  // A thread must not open on an assistant turn whose question was dropped.
  while (kept.length > 1 && kept[0].role === "assistant") kept.shift();
  return kept;
}

// ─── Screenshots (rule 95(l)) ────────────────────────────────────────────────
//
// Every image in the history would ride in every round, and each costs
// ~1,600 tokens on Claude at the widget's 1568 px — so only the newest
// MAX_RESENT_IMAGES are sent. An older one leaves a one-line note on its turn,
// so the model knows something was shown there. A model that cannot read
// images (llmService.acceptsImages) gets the note for every image.

export const MAX_RESENT_IMAGES = 4;

/**
 * Rides as a leading system message on a turn that carries images. A
 * screenshot is the person's view at some moment, possibly stale or of
 * another system — so it says what to look at, never what is true now.
 */
export const SCREENSHOT_GUIDANCE =
  "The person has attached one or more screenshots, usually of a Polaris screen. Read them to understand what they " +
  "are looking at and asking about (a hostname, a field, an error, a chart). A screenshot shows one moment and may be " +
  "out of date: any fact about this install that your answer depends on must still come from a lookup, and when a " +
  "lookup disagrees with the screenshot, say so and trust the lookup. Never repeat passwords, keys or tokens visible in a screenshot.";
/** Budgeting estimate for one image — Claude's cost for a 1568 px long edge. */
export const IMAGE_TOKENS = 1_600;

/** The ids of the newest `max` images in the history, newest turn first. Exported for tests. */
export function pickResentImages(turns: Array<{ imageIds?: string[] }>, max: number = MAX_RESENT_IMAGES): Set<string> {
  const out = new Set<string>();
  for (let i = turns.length - 1; i >= 0 && out.size < max; i--) {
    for (const id of turns[i].imageIds ?? []) {
      if (out.size >= max) break;
      out.add(id);
    }
  }
  return out;
}

/** The text a user turn carries to the model: its words, or a stand-in, plus a note for images not resent. Exported for tests. */
export function userTurnText(content: string, imageCount: number, resentCount: number, canRead: boolean): string {
  const lines = [content.trim() || (imageCount ? "(Screenshot sent without a question — say what it shows.)" : "")];
  const notSent = imageCount - resentCount;
  if (notSent > 0) {
    lines.push(canRead
      ? `[${notSent} earlier screenshot${notSent === 1 ? "" : "s"} attached here, not resent to save space]`
      : `[${notSent} screenshot${notSent === 1 ? "" : "s"} attached here — this model cannot read images]`);
  }
  return lines.filter(Boolean).join("\n");
}

/** The share of the prompt budget every tool definition together may take before the optional ones are held back. */
const TOOL_DEFS_SHARE = 0.45;

/**
 * The tools a turn offers. Every definition rides in every round, so on a
 * small local window the whole list would crowd out the system prompt and the
 * conversation — an overflowing prompt is not refused, the server drops the
 * OLDEST tokens, which are exactly those (seen live 2026-10-07). When all of
 * them fit in TOOL_DEFS_SHARE of the budget every tool is offered; otherwise
 * the WINDOW_OPTIONAL_TOOLS are offered only when the turn's playbook names
 * them (`keep`). Exported for tests.
 */
export function toolsForWindow<T extends { function: { name: string } }>(tools: T[], promptTokens: number, keep: ReadonlySet<string>): T[] {
  if (estimateTokens(JSON.stringify(tools)) <= promptTokens * TOOL_DEFS_SHARE) return tools;
  return tools.filter((t) => !WINDOW_OPTIONAL_TOOLS.has(t.function.name) || keep.has(t.function.name));
}

/**
 * When a long turn's lookups push the prompt past its budget, the OLDEST
 * lookup results are replaced by a one-line note — the model has already
 * read them, and the newest result is the one it is answering from.
 * Mutates `messages`. Exported for tests.
 */
export function compactToolResults(messages: ChatMessage[], budgetTokens: number): number {
  const size = () => messages.reduce((n, m) => n + estimateTokens(typeof m.content === "string" ? m.content : "") +
    ("tool_calls" in m && m.tool_calls ? estimateTokens(JSON.stringify(m.tool_calls)) : 0) + 4, 0);
  let compacted = 0;
  const toolIdx = messages.map((m, i) => (m.role === "tool" ? i : -1)).filter((i) => i >= 0);
  // Keep the newest result whatever happens.
  for (const i of toolIdx.slice(0, -1)) {
    if (size() <= budgetTokens) break;
    const m = messages[i] as { role: "tool"; tool_call_id: string; content: string };
    if (m.content.startsWith('{"omitted"')) continue;
    messages[i] = { ...m, content: '{"omitted":"earlier lookup result dropped to fit the model\'s context window"}' };
    compacted++;
  }
  return compacted;
}

/**
 * Run one streamed turn. Never throws once streaming has started: failures are
 * emitted as `error` events (and any partial answer is still saved).
 */
export async function streamAssistantTurn(input: {
  req: Request;
  userId: string;
  username?: string;
  conversationId: string;
  integration: AssistantIntegrationRef;
  content?: string;
  regenerate?: boolean;
  /** Pasted screenshots (rule 95(l)); the route has already checked the model accepts them. */
  images?: Buffer[];
  emit: AssistantEmit;
  signal: AbortSignal;
}): Promise<void> {
  const { req, integration, emit, signal } = input;
  if (!integration.config?.host) throw new AppError(409, `The "${integration.name}" integration has no host`);
  // A blank Model means "the server's default pick" (resolveChatModel); a
  // server that cannot be listed fails here, before the question is stored.
  const config: LlmConfig = { ...integration.config, model: await resolveChatModel(integration.id, integration.config) };

  const { question, images: storedImages } = await beginTurn(input.userId, input.conversationId, {
    content: input.content,
    regenerate: input.regenerate,
    integrationId: integration.id,
    images: input.images,
  });
  // Ownership passed and the question is stored: the route opens the stream
  // on this event, so its keep-alive covers a slow first token. `images` are
  // the stored ids, so the widget can swap its local previews for them.
  emit("start", { question, images: storedImages });

  const [allTurns, advisor, memoryOn, scope] = await Promise.all([
    recentTurns(input.conversationId, config.contextMessages ?? LLM_DEFAULTS.contextMessages),
    getEfficiencyAdvisor(input.userId),
    getMemoryEnabled(input.userId),
    // The person's regions + scope tags for the prompt; a failure only costs the hint.
    getEffectiveTagScopes(input.userId).catch(() => null),
  ]);
  // Rule 95(i): the person's memory rides in the system prompt (so the
  // context budget below counts it) and the remember/forget tools are offered
  // only while their "Remember things" switch is on.
  const memoryTurn: MemoryTurn | null = memoryOn
    ? {
      userId: input.userId,
      username: input.username,
      question,
      entries: await listMemory(input.userId),
      remembered: 0,
      forgotten: 0,
      onChange: (change) => emit("memory", change),
    }
    : null;
  const allTools = memoryTurn ? [...assistantToolDefs(), ...memoryToolDefs()] : assistantToolDefs();
  const budget = contextBudget(config.contextWindow);
  // What the turn did, for the Efficiency Advisor's sign-off (rule 95(h)).
  // Gathered whether or not the advisor is on; it costs a regex per lookup.
  const signals: TurnSignals = {
    question, outage: asksAboutOutage(question), failed: false,
    denied: false, usedHelp: false, lookedUp: false, found: false,
  };
  // Which voice the advisor speaks in (rule 95(k)): Polaris's canned lines on
  // a local model, the model in character on Azure AI Foundry — never both.
  const voice = advisorVoice(advisor, config.provider);
  // The model's character stays on through outages too (owner's call,
  // 2026-10-09): ADVISOR_PERSONA forbids joking about the devices or the
  // outage and aims the character at the person instead. The canned voice
  // (local models) does the same with its `letDown` lines (pickCategory).
  const personaActive = voice === "model";
  const systemPrompt = buildSystemPrompt({
    username: input.username,
    extra: config.systemPromptExtra,
    // In character the model's name is R.A.L.P.H. (ADVISOR_PERSONA); the
    // configured assistant name would give it two.
    displayName: personaActive ? undefined : config.displayName,
    persona: personaActive ? ADVISOR_PERSONA : undefined,
    access: [permissionsPromptBlock(req.roleSnapshot ?? req.session?.roleSnapshot), scopePromptBlock(scope)]
      .filter(Boolean).join("\n") || null,
    memory: memoryTurn ? memoryPromptBlock(memoryTurn.entries, input.username) : undefined,
  });
  // A playbook (assistantPlaybookService) steers a multi-step question: its
  // procedure rides as a second leading system message for this turn and its
  // tools are the only ones offered on round 0. A report request or a how-to
  // keeps priority (they steer round 0 themselves, below).
  const playbook = !asksForReport(question) && !asksHowTo(question) ? pickPlaybook(question) : null;
  const tools = toolsForWindow(allTools, budget.promptTokens, new Set(playbook?.firstRoundTools ?? []));
  // Rule 95(l): the newest screenshots ride along, costed into the history budget.
  const canReadImages = acceptsImages(config);
  const resent = canReadImages ? pickResentImages(allTurns) : new Set<string>();
  const turns = fitHistory(
    estimateTokens(systemPrompt) + estimateTokens(JSON.stringify(tools)) + (playbook ? estimateTokens(playbook.guidance) : 0),
    allTurns.map((t) => ({ ...t, extraTokens: (t.imageIds ?? []).filter((id) => resent.has(id)).length * IMAGE_TOKENS })),
    budget.promptTokens,
  );
  const imageBytes = await loadTurnImages(turns.flatMap((t) => (t.imageIds ?? []).filter((id) => resent.has(id))));
  const historyMessages: ChatMessage[] = turns.map((t): ChatMessage => {
    if (t.role === "assistant") return { role: "assistant", content: t.content };
    const ids = t.imageIds ?? [];
    const images = ids.flatMap((id) => {
      const img = imageBytes.get(id);
      return img ? [img] : [];
    });
    return {
      role: "user",
      content: userTurnText(t.content, ids.length, images.length, canReadImages),
      ...(images.length ? { images } : {}),
    };
  });
  const recentLines = voice === "canned" ? await recentAdvisorLines(input.conversationId) : null;
  // One canned line per turn, leading (at the first lookup) or closing (under
  // the answer) — a coin flip, so neither becomes a formula. A turn that runs
  // no lookup can only close.
  const leadWithLine = recentLines ? advisorLeads() : false;
  // The line shown when the first lookup starts; retracted on an outage.
  let preface: string | null = null;
  let prefaceOffered = false;
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...(playbook ? [{ role: "system" as const, content: playbook.guidance }] : []),
    ...(imageBytes.size ? [{ role: "system" as const, content: SCREENSHOT_GUIDANCE }] : []),
    ...historyMessages,
  ];
  // A playbook narrows round 0 to its lookups, but never hides the memory tools: a user who says
  // "remember X, and what is the status of Y?" is still asking for a write, and the grounding
  // check (rule 95(i)) only runs when the model can reach `remember` at all.
  const playbookTools = playbook
    ? tools.filter((t) => playbook.firstRoundTools.includes(t.function.name) || MEMORY_TOOL_NAMES.has(t.function.name))
    : [];
  const wantsReport = asksForReport(question);
  const reportOnlyTools = tools.filter((t) => t.function.name === "create_report");
  const wantsHowTo = !wantsReport && asksHowTo(question);
  const helpOnlyTools = tools.filter((t) => t.function.name === "search_help");
  let lastListCall: { name: string; args: string } | null = null;
  // Every uuid a lookup returned this turn — the only ids an asset link may name.
  const seenIds = new Set<string>();
  // Every tool, offered or not: a call the model writes as text is still run
  // when it names a real tool (runAssistantTool checks the caller's role).
  const toolNames = allTools.map((t) => t.function.name);
  const maxRounds = Math.min(Math.max(config.maxToolRounds ?? LLM_DEFAULTS.maxToolRounds, 1), 12);
  const maxRows = Math.min(Math.max(config.maxRowsPerTool ?? LLM_DEFAULTS.maxRowsPerTool, 10), 1000);

  let answer = "";
  const toolsUsed: ToolUseRecord[] = [];
  const reports: AssistantReportPayload[] = [];
  const toolCtx = {
    req,
    maxRows,
    onReport: (r: AssistantReportPayload) => {
      reports.push(r);
      emit("report", r);
    },
    reportFormats: reportFormatsFromQuestion(question),
  };
  let stopped = false;
  let failure: string | null = null;

  // Once a report exists in this turn, later rounds are HELD rather than
  // streamed: the model has not seen the report's rows (create_report hands
  // it a count), so a table it types afterwards is invented — seen live
  // 2026-10-07, a re-typed "report" listing networks that do not exist next
  // to the real card. Held text is shown only after stripMarkdownTables.
  let held: string | null = null;
  const onText = (text: string) => {
    if (held !== null) { held += text; return; }
    answer += text;
    emit("token", { text });
  };

  // A thinking model reasons silently before it answers — tens of seconds on
  // modest hardware. Its reasoning is never shown; how much it has written is,
  // at most every 400 ms, so the widget can say it is working.
  let reasoningTotal = 0;
  let roundReasoning = 0;
  let lastThinkingEmit = 0;
  const onReasoning = (roundChars: number) => {
    const total = reasoningTotal + roundChars;
    roundReasoning = roundChars;
    const now = Date.now();
    if (now - lastThinkingEmit < 400) return;
    lastThinkingEmit = now;
    emit("thinking", { chars: total });
  };

  try {
    for (let round = 0; ; round++) {
      const lastRound = round >= maxRounds;
      const roundStart = answer.length;
      held = reports.length > 0 ? "" : null;
      // A message that plainly asks for a report is offered ONLY create_report
      // on its first round — small models otherwise reach for the familiar
      // list tool and answer in prose (seen live 2026-10-07, qwen2.5:7b:
      // "give me a report on the network utilizations" → list_networks, no card).
      const roundTools = lastRound ? []
        : round === 0 && wantsReport ? reportOnlyTools
        : round === 0 && wantsHowTo ? helpOnlyTools
        : round === 0 && playbookTools.length ? playbookTools
        : tools;
      compactToolResults(messages, budget.promptTokens);
      roundReasoning = 0;
      const res = await chatCompletionRound(config, messages, roundTools, { signal, onText, onReasoning });
      reasoningTotal += roundReasoning;
      const wasHeld = held !== null;
      held = null;
      let calls = res.toolCalls;
      let roundText = res.content;
      if (calls.length === 0 && !lastRound) {
        // A tool call the model WROTE instead of making (llmService.recoverTextToolCalls).
        // Run it, and withdraw that round's text from the reply — shown, it
        // reads as noise; stored, the model copies it on every later turn.
        calls = recoverTextToolCalls(res.content, toolNames);
        if (calls.length) {
          if (!wasHeld) {
            answer = answer.slice(0, roundStart);
            emit("retract", { from: roundStart });
          }
          roundText = "";
        }
      }
      if (wasHeld && roundText) {
        roundText = stripMarkdownTables(roundText);
        if (!roundText.trim() && calls.length === 0) roundText = REPORT_READY_TEXT;
        if (roundText.trim()) onText(roundText);
      }
      const spoke = Boolean(roundText.trim());
      if (calls.length === 0 || lastRound) break;

      // `raw` (Claude's own blocks, thinking included) is replayed verbatim —
      // but only for calls the model really made, not ones recovered from text.
      messages.push({ role: "assistant", content: spoke ? roundText : null, tool_calls: calls, raw: calls === res.toolCalls ? res.raw : undefined });
      // A round that spoke before calling tools ("Let me check…") gets a
      // paragraph break so the next round's text doesn't run on.
      if (spoke && !answer.endsWith("\n")) onText("\n\n");

      for (const tc of calls) {
        if (signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
        const name = tc.function.name;
        // remember / forget (rule 95(i)) write the caller's own memory: not a
        // lookup, so no Efficiency Advisor line and no lookup signals.
        if (memoryTurn && MEMORY_TOOL_NAMES.has(name)) {
          const label = memoryToolLabel(name) ?? name;
          emit("tool", { name, label, status: "running" });
          const result = await runMemoryTool(name, tc.function.arguments, memoryTurn);
          toolsUsed.push({ name, label, ok: result.ok });
          emit("tool", { name, label, status: "done", ok: result.ok });
          messages.push({ role: "tool", tool_call_id: tc.id, content: clipJson(result.data, budget.toolResultChars) });
          continue;
        }
        // Outage turns get a line too (owner's call, 2026-10-09) — every
        // LOOKUP_LINES entry is about the person, never the devices.
        if (recentLines && leadWithLine && !prefaceOffered) {
          preface = pickLookupLine(recentLines.prefaces);
          emit("preface", { text: preface });
        }
        prefaceOffered = true;
        emit("tool", { name, label: toolLabel(name), status: "running" });
        const result = await runAssistantTool(name, tc.function.arguments, toolCtx);
        toolsUsed.push({ name, label: toolLabel(name), ok: result.ok });
        emit("tool", { name, label: toolLabel(name), status: "done", ok: result.ok });
        const content = clipJson(result.data, budget.toolResultChars);
        // Every asset id a lookup returned this turn — `id` on a row, the
        // gate / far end an IPsec search hit names in its context, and the
        // switch / gateway / AP / matched device a find_endpoint sighting names.
        for (const m of content.matchAll(/"(?:id|assetId|peerAssetId|switchId|seenById|knownAsId|accessPointId)":"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/g)) seenIds.add(m[1]);
        messages.push({ role: "tool", tool_call_id: tc.id, content });
        if (result.ok && REPORT_SOURCES.has(name)) lastListCall = { name, args: tc.function.arguments };
        noteLookup(signals, name, result, content);
      }
    }

    // Asked for a report, got a plain lookup: build the report from that
    // lookup, same filters, so the operator gets the download they asked for.
    if (wantsReport && reports.length === 0 && lastListCall && !signal.aborted) {
      let args: unknown = {};
      try { args = JSON.parse(lastListCall.args || "{}"); } catch { args = {}; }
      emit("tool", { name: "create_report", label: toolLabel("create_report"), status: "running" });
      const result = await runAssistantTool(
        "create_report",
        JSON.stringify({ title: reportTitleFromQuestion(question), source: lastListCall.name, args }),
        toolCtx,
      );
      toolsUsed.push({ name: "create_report", label: toolLabel("create_report"), ok: result.ok });
      emit("tool", { name: "create_report", label: toolLabel("create_report"), status: "done", ok: result.ok });
    }
  } catch (err) {
    if (isAbort(err, signal)) {
      stopped = true;
    } else {
      failure = err instanceof AppError ? err.message : (err as Error)?.message || "The assistant failed";
      logger.warn({ err, integrationId: integration.id }, "assistant: turn failed");
    }
  }

  // Links may only go to a real help page or inside Polaris (sanitizeAnswerLinks).
  // The answer streamed as written, so a changed answer is replaced whole.
  if (answer) {
    const clean = sanitizeAnswerLinks(answer, await wikiPageNames(), seenIds);
    if (clean !== answer) {
      answer = clean;
      emit("retract", { from: 0 });
      emit("token", { text: answer });
    }
  }

  // The Efficiency Advisor sign-off (rule 95(h)): picked here, never written
  // by the model; none after an error or a Stop, and none when this turn's
  // line already led (the before-lookup line) — one line per turn.
  let signOff: string | null = null;
  if (recentLines && !preface && (answer.trim() || reports.length)) {
    signals.failed = stopped || failure !== null;
    signOff = pickSignOff(signals, recentLines.signOffs);
    if (signOff) emit("signoff", { text: signOff });
  }

  // Persist whatever the user saw. An error before any text stores nothing —
  // the question stays and /retry re-asks it.
  let messageId: string | null = null;
  if (answer.trim() || reports.length) {
    const saved = await finishTurn(input.conversationId, {
      content: answer,
      toolsUsed,
      stopped: stopped || failure !== null,
      reports,
      preface,
      signOff,
    });
    messageId = saved.messageId;
  }

  void logEvent({
    action: "assistant.chat",
    resourceType: "integration",
    resourceId: integration.id,
    resourceName: integration.name,
    actor: input.username,
    level: failure ? "warning" : "info",
    // The question and answer are deliberately not logged — the conversation
    // is the owner's data (rule 95(d)); the audit trail records that it
    // happened and which lookups ran.
    message: failure
      ? `Assistant turn failed for ${input.username ?? "a user"}: ${failure}`
      : `Assistant answered ${input.username ?? "a user"}${toolsUsed.length ? ` using ${Array.from(new Set(toolsUsed.map((t) => t.name))).join(", ")}` : ""}${stopped ? " (stopped)" : ""}`,
    details: { tools: toolsUsed.map((t) => t.name), reports: reports.length, stopped, ...(playbook ? { playbook: playbook.id } : {}) },
  });

  if (failure) emit("error", { message: failure, messageId });
  else emit("done", { messageId, stopped });
}
