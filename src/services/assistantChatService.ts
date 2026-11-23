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
  effectiveContextWindow,
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

/**
 * Ceiling on one tool result handed back to the model (characters of JSON);
 * contextBudget sizes it down for small windows. It was 24,000 whatever the
 * window — about 30 asset rows even on a 1M-token deployment (rule 95(o)).
 */
const TOOL_RESULT_MAX_CHARS = 120_000;

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
const DEFAULT_IDLE_RESET_MINUTES = 30;

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

/**
 * The instructions every turn shares, byte for byte (rule 95(o)). Kept apart
 * from the per-turn lines so the START of the prompt never changes: Azure's
 * automatic prefix caching and a local server's reuse of an already-read
 * prompt (Ollama / llama.cpp KV cache) both stop at the first changed token,
 * and the millisecond timestamp that used to open the prompt changed it on
 * every turn. Ordered most important first — a small model reads the top.
 */
const CORE_PROMPT_LINES = [
  "Core rules, most important first:",
  "1. Every fact about THIS install (devices, alerts, networks, events, counts, addresses, times) comes from a " +
    "lookup you run THIS turn. Never invent hostnames, IPs, counts or timestamps. If the lookups return nothing, " +
    "say so. Never say you checked something you did not look up this turn.",
  "2. A lookup that says \"N of TOTAL\" sent you only N rows. Speak only about those rows: counts and " +
    "breakdowns come from count_assets (or a result's breakdown field), and the full list is a create_report. " +
    "A field missing from a row is empty.",
  "3. Before saying something is absent or zero, try the other ways it could be recorded (region, tag, " +
    "location, search, list_alerts) and say what you tried. If the person says it exists, believe them over one " +
    "empty lookup and keep looking.",
  "",
  "How to work:",
  "- Talk naturally; earlier turns are context. Polaris starts each earlier message with a [Polaris: …] line: " +
    "when it was sent and, for an answer, the lookups and reports it ran. Never write such a line yourself. An " +
    "earlier answer whose line lists lookups did come from Polaris at that time — do not disown or apologise for " +
    "it — but its figures are as of then: re-run a lookup before repeating, building on or correcting one, and " +
    "correct it only when a lookup this turn contradicts it. An answer marked \"no lookups ran\" is unverified.",
  "- For how to use, configure or troubleshoot Polaris, call search_help first and answer ONLY from what it " +
    "returns, linking the page with the exact url it gave, as [Page — Section](url). Never make up a link, a " +
    "page, a button or a menu. If the help has nothing, say you are not sure.",
  "- When the how-to is about ADDING something (an asset, a network, a reservation, a block…) and the person " +
    "named it (a hostname, IP, MAC, CIDR or name), look it up BEFORE answering and open with whether it already " +
    "exists — if it does, say where and that the add would be a duplicate. If they did not name it, say how to " +
    "check first (the search bar at the top; for an asset, the panel under + Add Asset that checks the IP as it " +
    "is typed) AND offer to do the search for them — \"or tell me the name or IP and I will check\". Never imply " +
    "someone is about to create a duplicate unless a lookup showed one.",
  "- Which lookup: counts and breakdowns → count_assets; CPU / memory figures → telemetry_summary (never " +
    "estimate a percentage); anything else a device's details page shows → asset_details; one network's " +
    "addresses → get_network; who is connected through a FortiGate's IPsec / VPN → list_ipsec_connections; " +
    "uptime is on list_assets and telemetry_summary rows. A region (e.g. \"Middle Tennessee\") is region: [name] " +
    "— never location or search, which do not read region tags. To narrow to devices named earlier, pass their " +
    "exact names as hostname — never invent a filter a lookup does not list.",
  "- To correlate an issue, look at the device (get_asset), then what else alerted or changed state in the same " +
    "window (list_alerts / list_events), and the upstream device it depends on. Separate what the data shows from " +
    "what you infer.",
  "- A device may have HELD an address it no longer shows as its IP (matchedOn: \"ipHistory\" on a search hit; " +
    "ipHistory on get_asset). That device IS the answer for that address: say it held it, from which source and " +
    "when it was last seen there. Never dismiss such a hit as a text match.",
  "- For a report, export, download or spreadsheet, call create_report with the right source and filters, and " +
    "formats set to the ones the user named (e.g. [\"pdf\"]). The user sees the finished table with download " +
    "buttons; you do not see its rows, so never type a table or rows for it — reply with one sentence naming " +
    "what it holds.",
  "- You can only look things up: you cannot change, acknowledge, push or delete anything in Polaris; if asked, " +
    "explain where in Polaris the user can do it. When a lookup answers 'Not permitted', say their role does not " +
    "allow it; do not work around it.",
  "- Use the names Polaris shows on screen. Sidebar: Dashboard, Device Map, Application Map, Path Monitor, IPAM, " +
    "Assets, Events, Automations, Integrations, Users, Server Settings. IPAM has two tabs, IP Blocks (+ Add Block) " +
    "and Networks (+ Add Network). Never call a network a \"subnet\" — no screen in Polaris uses that word.",
  "- When you name an asset a lookup returned, link it as [hostname](/assets.html#view=asset:ID) with the id " +
    "from that lookup — never a guessed or remembered id. Only assets are linked this way.",
  "- Leave decommissioned assets and retired networks out unless asked — the lookups already omit them.",
  "- Keep answers concise: short Markdown tables up to ~15 rows, a report beyond. Never name your tools to the " +
    "user (list_assets, create_report, …) — say what you looked up in plain words (\"I checked the networks\").",
].join("\n");

/** The system prompt. Exported for tests. */
export function buildSystemPrompt(opts: { username?: string; now?: Date; extra?: string; displayName?: string; persona?: string; memory?: string; access?: string | null }): string {
  const now = opts.now ?? new Date();
  const name = opts.displayName?.trim();
  const lines = [
    (name ? `Your name is ${name}. ` : "") +
    "You are the Polaris assistant, built into Polaris — a monitoring and asset management tool that monitors " +
      "network devices and servers, raises alerts through automations, and keeps one multi-source asset record " +
      "per device (from FortiManager/FortiGate, Entra ID/Intune, Active Directory, Windows DHCP, vCenter, Azure " +
      "Arc, Unraid, TrueNAS, Proxmox VE and Generic API feeds), plus an IP address registry.",
    "",
    CORE_PROMPT_LINES,
  ];
  // Everything below changes per person or per turn, so it comes after the
  // shared instructions. The access block names the caller's role.
  if (opts.access) lines.push("", opts.access);
  // The Efficiency Advisor persona (rule 95(k)): only on a hosted model, only
  // for a user who ticked it. Before the operator's instructions, so those
  // still have the last word.
  if (opts.persona?.trim()) lines.push("", opts.persona.trim());
  if (opts.extra?.trim()) lines.push("", "Operator instructions:", opts.extra.trim());
  // Rule 95(i): the person's memory, framed as background about them — after
  // the operator's instructions so it can never read as overriding them.
  if (opts.memory) lines.push("", opts.memory, "Remembering things about the person is the one thing you may write.");
  // Last, and to the minute: the only line that changes turn to turn.
  const minute = now.toISOString().slice(0, 16).replace("T", " ");
  lines.push("", `Current time: ${minute} UTC.${opts.username ? ` You are talking to ${opts.username}.` : ""}`);
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
  if (/\b(how (do|can|should|would) (i|we|you)|how to|steps to|walk me through|what does .{1,40} mean|is it possible to)\b/i.test(t)) return true;
  // "where is", "configure" and "set up" are how-to words only about Polaris
  // itself: "where is sw-nsh-02?" is a data question, and offered search_help
  // alone a small model answered it from the help (rule 95(o), 2026-11-23).
  if (!/\b(where (do|can|is|are|would) |configure|set up|setup)\b/i.test(t)) return false;
  if (namesAThing(t)) return false;
  return /\b(page|tab|settings?|menu|button|screen|integrations?|automations?|profiles?|roles?|permissions?|dashboards?|widgets?|wizard|option|toggle|sidebar|theme|polaris|change|edit|enable|disable|turn (on|off)|create|delete|find the|see the|view the)\b/i.test(t);
}

/**
 * Does the text name a specific device or address — an IPv4, a MAC, or a
 * hostname-shaped token (letters and digits joined by "-" or ".")? Exported for tests.
 */
export function namesAThing(text: string): boolean {
  return /\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(text)
    || /\b[0-9a-f]{2}([:-])[0-9a-f]{2}(\1[0-9a-f]{2}){2,4}\b/i.test(text)
    || /(?<![\w.-])(?=[\w.-]*\d)(?=[\w.-]*[a-z])[a-z0-9]+(?:[-.][a-z0-9]+)+(?![\w-])/i.test(text);
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
 * An answer that reads as looked up: it says it checked, or it counts devices.
 * Asked of a turn that ran NO lookup (rule 95(m)) — seen live 2026-10-28 on
 * Foundry Claude Haiku 5.5 with the Efficiency Advisor persona: "214
 * firewalls", a device's detail and a profile's contents, each said to be
 * checked, with no tool called. Tuned for that, not for recall: a plain
 * how-to or small talk must not match. Exported for tests.
 */
export function claimsUnlookedFacts(text: string): boolean {
  return (
    /\bI(?:'ve| have)?\s+(?:just\s+|already\s+)?(?:checked|looked(?:\s+it)?\s+up|looked\s+at|verified|confirmed|queried|pulled|reviewed|searched)\b/i.test(text) ||
    /\b\d[\d,]*\s+(?:firewalls?|switch(?:es)?|access\s+points?|APs|devices?|assets?|servers?|networks?|subnets?|reservations?|alerts?)\b/i.test(text) ||
    /\baccording to (?:Polaris|the inventory|your inventory|the data)\b/i.test(text)
  );
}

/**
 * Sent once, as the user's side of the turn, when an answer claimed facts
 * without a lookup: the answer is withdrawn and the model asked again.
 */
const LOOKUP_NUDGE =
  "(From Polaris, not the user.) Your reply stated facts about this install, but you ran no lookup this turn, " +
  "so none of them are verified. Figures from earlier answers are not lookups for this turn either. Call the " +
  "tools that answer the question now, then answer only from what they return. If no tool can answer it, say " +
  "that instead of giving figures. Do not apologise for or retract earlier answers unless a lookup now " +
  "contradicts them.";

/** Added by Polaris under an answer that still claimed facts after the nudge. */
const UNVERIFIED_NOTE = "\n\n_Polaris ran no lookup for this answer, so its figures are not from your install._";

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

/** A row without its empty fields (null, "", []) — they cost the model's window and say nothing. */
function leanRow(v: unknown): unknown {
  if (!v || typeof v !== "object" || Array.isArray(v)) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (x === null || x === undefined || x === "" || (Array.isArray(x) && x.length === 0)) continue;
    out[k] = x;
  }
  return out;
}

/**
 * A lookup result as the model reads it (rule 95(o)). Rows lose their empty
 * fields, and a result too long for the window loses whole ROWS from the end
 * of its largest list — never a cut through the JSON. A list result's
 * `returned` / `truncated` are rewritten to what was actually sent and a note
 * says "N of TOTAL" after the rows: the char cut this replaces left
 * `returned: 200` in front of the ~30 rows that fit, and the model counted
 * and ranked from the fragment as if it held all 200 (seen live 2026-11-23).
 * Exported for tests.
 */
export function fitToolResult(value: unknown, maxChars: number): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return clipJson(value, maxChars);
  const data: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  // Every list at the top level and one level down (get_network nests its rows).
  type Slot = { holder: Record<string, unknown>; key: string; items: unknown[]; path: string };
  const slots: Slot[] = [];
  const collect = (holder: Record<string, unknown>, prefix: string, depth: number) => {
    for (const [k, v] of Object.entries(holder)) {
      if (Array.isArray(v)) {
        const items = v.map(leanRow);
        holder[k] = items;
        slots.push({ holder, key: k, items, path: prefix + k });
      } else if (depth === 0 && v && typeof v === "object") {
        const copy = { ...(v as Record<string, unknown>) };
        holder[k] = copy;
        collect(copy, `${k}.`, 1);
      }
    }
  };
  collect(data, "", 0);
  const isList = Array.isArray(data.rows) && typeof data.total === "number";
  const listTotal = isList ? (data.total as number) : 0;
  const clipped: Record<string, string> = {};
  const annotate = () => {
    if (isList) {
      const sent = (data.rows as unknown[]).length;
      data.returned = sent;
      data.truncated = listTotal > sent;
      if (listTotal > sent) {
        data.sent = `${sent} of ${listTotal}`;
        data.note = `Only these ${sent} of ${listTotal} matching rows were sent to you — the rest did not fit. ` +
          "Do not count, rank or summarise beyond them: counts and breakdowns come from count_assets (or the " +
          "breakdown field when present); the full list is create_report.";
      }
    }
    if (Object.keys(clipped).length) {
      data.clipped = clipped;
      if (!isList) data.note = "Lists marked in `clipped` were cut to fit: speak only about the entries you received.";
    }
  };
  // A list the lookup already capped (200 of 1,964) says so even when it fits.
  annotate();
  let s = JSON.stringify(data);
  if (s.length <= maxChars) return s;
  // Trim the largest list first, by whole entries, until the result fits.
  for (let guard = 0; guard < 8 && s.length > maxChars; guard++) {
    const slot = slots
      .filter((x) => (x.holder[x.key] as unknown[]).length > 0)
      .sort((a, b) => JSON.stringify(b.holder[b.key]).length - JSON.stringify(a.holder[a.key]).length)[0];
    if (!slot) break;
    const had = (slot.holder[slot.key] as unknown[]).length;
    const sizeWith = (n: number): number => {
      slot.holder[slot.key] = slot.items.slice(0, n);
      if (n < slot.items.length) clipped[slot.path] = `${n} of ${slot.items.length}`;
      else delete clipped[slot.path];
      annotate();
      return JSON.stringify(data).length;
    };
    let lo = 0, hi = had - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (sizeWith(mid) <= maxChars) lo = mid;
      else hi = mid - 1;
    }
    sizeWith(lo);
    // The list's own "N of TOTAL" says it; `clipped` would only repeat it.
    if (isList && slot.path === "rows") delete clipped.rows;
    if (!Object.keys(clipped).length) delete data.clipped;
    annotate();
    s = JSON.stringify(data);
  }
  return s.length <= maxChars ? s : clipJson(data, maxChars);
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

const MAX_RESENT_IMAGES = 4;

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

/**
 * The line Polaris puts at the top of every turn it resends (rule 95(n)):
 * when it was said and, for an answer, which lookups and reports it ran.
 * Without it the model could not tell a looked-up answer from an invented
 * one, nor an answer given before Polaris could see something from one given
 * after — seen live 2026-10-28: told "earlier answers are not lookups", it
 * disowned a real uptime ranking two turns later. Labels and counts only,
 * never results (rule 95(d)). Exported for tests.
 */
export function turnHeader(t: {
  role: "user" | "assistant";
  createdAt: Date;
  toolsUsed?: ToolUseRecord[];
  reports?: Array<{ title: string; rowCount: number }>;
}): string {
  const at = t.createdAt.toISOString().slice(0, 16).replace("T", " ") + " UTC";
  if (t.role === "user") return `[Polaris: sent ${at}]`;
  const ran = Array.from(new Set((t.toolsUsed ?? []).map((u) => u.label + (u.ok ? "" : " (failed)"))));
  const parts = [`answered ${at}`];
  parts.push(ran.length ? `lookups it ran: ${ran.join(", ")}` : "no lookups ran, so its facts are unverified");
  for (const r of t.reports ?? []) parts.push(`report built: "${r.title}" (${r.rowCount} rows)`);
  return `[Polaris: ${parts.join(" · ")}]`;
}

/**
 * Remove turn headers (turnHeader) a model copied into its own answer — a
 * model copies what its history shows (the trap of rule 95(h)). Only whole
 * lines, so prose that mentions Polaris in brackets is left. Exported for tests.
 */
export function stripTurnHeaders(text: string): string {
  if (!text.includes("[Polaris:")) return text;
  return text.replace(/^[ \t]*\[Polaris: (?:sent|answered) [^\]\n]*\][ \t]*(?:\r?\n)*/gm, "").trimStart();
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
  // The provider's default when the field is blank, capped on model-router (rule 95(o)).
  const budget = contextBudget(effectiveContextWindow(config));
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
  // Rule 95(n): every resent turn opens with its turnHeader, costed in too.
  const turns = fitHistory(
    estimateTokens(systemPrompt) + estimateTokens(JSON.stringify(tools)) + (playbook ? estimateTokens(playbook.guidance) : 0),
    allTurns.map((t) => {
      const header = turnHeader(t);
      return { ...t, header, extraTokens: estimateTokens(header) + (t.imageIds ?? []).filter((id) => resent.has(id)).length * IMAGE_TOKENS };
    }),
    budget.promptTokens,
  );
  const imageBytes = await loadTurnImages(turns.flatMap((t) => (t.imageIds ?? []).filter((id) => resent.has(id))));
  const historyMessages: ChatMessage[] = turns.map((t): ChatMessage => {
    if (t.role === "assistant") return { role: "assistant", content: `${t.header}\n${t.content}` };
    const ids = t.imageIds ?? [];
    const images = ids.flatMap((id) => {
      const img = imageBytes.get(id);
      return img ? [img] : [];
    });
    return {
      role: "user",
      content: `${t.header}\n${userTurnText(t.content, ids.length, images.length, canReadImages)}`,
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
  // A how-to opens on the help, but keeps the two lookups that say whether
  // the thing asked about exists — help ALONE made a small model answer data
  // questions from the documentation (rule 95(o)).
  const HOW_TO_TOOLS = new Set(["search_help", "search", "list_assets"]);
  const howToTools = tools.filter((t) => HOW_TO_TOOLS.has(t.function.name));
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
  let lookups = 0;
  let nudged = false;

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
        : round === 0 && wantsHowTo ? howToTools
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
      // Rule 95(m): an answer that claims facts with no lookup behind it is
      // withdrawn and asked again, once, with every tool on offer.
      if (calls.length === 0 && !lastRound && !nudged && lookups === 0 && reports.length === 0 && tools.length > 0 && claimsUnlookedFacts(answer)) {
        nudged = true;
        messages.push({ role: "assistant", content: answer });
        messages.push({ role: "user", content: LOOKUP_NUDGE });
        answer = "";
        emit("retract", { from: 0 });
        continue;
      }
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
        lookups++;
        toolsUsed.push({ name, label: toolLabel(name), ok: result.ok });
        emit("tool", { name, label: toolLabel(name), status: "done", ok: result.ok });
        const content = fitToolResult(result.data, budget.toolResultChars);
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

  // Asked again and still no lookup: the answer stands, and Polaris says so.
  if (nudged && lookups === 0 && !stopped && failure === null && claimsUnlookedFacts(answer)) {
    answer += UNVERIFIED_NOTE;
    emit("token", { text: UNVERIFIED_NOTE });
  }

  // Links may only go to a real help page or inside Polaris (sanitizeAnswerLinks).
  // The answer streamed as written, so a changed answer is replaced whole.
  // A copied turn header (rule 95(n)) goes the same way.
  if (answer) {
    const clean = sanitizeAnswerLinks(stripTurnHeaders(answer), await wikiPageNames(), seenIds);
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
