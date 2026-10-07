/**
 * src/services/assistantChatService.ts — one assistant turn, streamed
 * (business rule 95).
 *
 *   1. beginTurn stores the user's question (or, for /retry, drops the last
 *      answer) — ownership is checked there.
 *   2. The last N turns + a system prompt go to the `llm` integration's
 *      OpenAI-compatible endpoint with the assistant tool definitions.
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
 *   tool   { name, label, status, ok? }   status: "running" | "done"
 *   report { id?, title, columns, rows, rowCount, truncated }
 *   done   { messageId, stopped }
 *   error  { message }
 */

import type { Request } from "express";
import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { logEvent } from "./eventLogService.js";
import {
  chatCompletionRound,
  resolveChatModel,
  recoverTextToolCalls,
  LLM_DEFAULTS,
  type ChatMessage,
  type LlmConfig,
} from "./llmService.js";
import {
  assistantToolDefs,
  runAssistantTool,
  toolLabel,
  type AssistantReportPayload,
} from "./assistantToolService.js";
import {
  beginTurn,
  finishTurn,
  recentTurns,
  getEfficiencyAdvisor,
  recentAdvisorLines,
  type ToolUseRecord,
} from "./assistantConversationService.js";
import { WIKI_BASE_URL, wikiPageNames } from "./helpIndexService.js";
import {
  asksAboutOutage,
  lookupShowsOutage,
  lookupFoundSomething,
  topicForTool,
  pickSignOff,
  pickLookupLine,
  type TurnSignals,
} from "./efficiencyAdvisorService.js";

export type AssistantEmit = (event: "start" | "token" | "retract" | "tool" | "report" | "preface" | "signoff" | "done" | "error", data: unknown) => void;

/** Cap on one tool result handed back to the model (characters of JSON). */
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
export async function listAssistantIntegrations(): Promise<Array<{ id: string; name: string; model: string; displayName: string }>> {
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

/** The system prompt. Exported for tests. */
export function buildSystemPrompt(opts: { username?: string; now?: Date; extra?: string; displayName?: string }): string {
  const now = opts.now ?? new Date();
  const name = opts.displayName?.trim();
  const lines = [
    (name ? `Your name is ${name}. ` : "") +
    "You are the Polaris assistant, built into Polaris — an asset management and network monitoring tool " +
      "that pulls FortiManager/FortiGate, Entra ID/Intune, Active Directory, Windows DHCP, vCenter and Azure Arc " +
      "into one multi-source asset record, monitors devices, raises alerts through automations, and keeps an " +
      "IP address registry (blocks, networks, reservations).",
    `Current time: ${now.toISOString()} (UTC).${opts.username ? ` You are talking to ${opts.username}.` : ""}`,
    "",
    "How to work:",
    "- Talk naturally. Small talk and follow-up questions are fine; earlier turns are context.",
    "- Any fact about THIS install (devices, alerts, networks, events, counts, times) must come from a tool. " +
      "Never invent hostnames, IPs, counts or timestamps. If the tools return nothing, say so.",
    "- For questions about how to use, configure or troubleshoot Polaris, call search_help first and answer ONLY " +
      "from what it returns, linking the page with the exact url it gave, as [Page — Section](url). Never make up a " +
      "link, a page, a button or a menu. If the help has nothing, say you are not sure.",
    "- Use the names Polaris shows on screen. Sidebar: Dashboard, Device Map, Application Map, Path Monitor, IPAM, " +
      "Assets, Events, Automations, Integrations, Users, Server Settings. IPAM has two tabs, IP Blocks (+ Add Block) " +
      "and Networks (+ Add Network). Never call a network a \"subnet\" — no screen in Polaris uses that word.",
    "- When a tool answers 'Not permitted', tell the user their role does not allow that; do not try to work around it.",
    "- To correlate an issue, look at the device (get_asset), then what else alerted or changed state in the same " +
      "time window (list_alerts / list_events with hours or since/until), and the upstream device it depends on. " +
      "Separate what the data shows from what you infer.",
    "- When the user asks for a report, export, list to download, or spreadsheet, call create_report with the " +
      "right source and filters. The user sees the finished table with download buttons; you do not see its rows, " +
      "so never type a table or rows for it — reply with one sentence naming what it holds.",
    "- You can only look things up. You cannot change, acknowledge, push or delete anything; if asked, explain where " +
      "in Polaris the user can do it.",
    "- Keep answers concise. Use short Markdown tables for up to ~15 rows; offer a report for more.",
    "- Never mention your tools or their names (list_assets, create_report, …) to the user — say what you looked " +
      "up in plain words (\"I checked the networks\").",
  ];
  if (opts.extra?.trim()) lines.push("", "Operator instructions:", opts.extra.trim());
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
export function sanitizeAnswerLinks(text: string, wikiPages: ReadonlySet<string>): string {
  const allowed = (url: string): boolean => {
    const u = url.trim();
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
const REPORT_SOURCES: ReadonlySet<string> = new Set(["list_assets", "list_alerts", "list_events", "list_networks", "list_reservations"]);

/**
 * Does this message plainly ask for a downloadable report? Deliberately
 * narrow — a false hit only means the first round is offered create_report
 * alone. `/report` arrives as "Create a downloadable report: …". Exported for tests.
 */
export function asksForReport(text: string): boolean {
  const t = text.trim();
  // "How do I export…", "where is the report…" are help questions, not requests.
  if (/^(how|where|why|when|what is|what's|what are|can i|could i|is there|does|do you)\b/i.test(t)) return false;
  return /\b(report|reports|export|download|downloadable|spreadsheet|csv|pdf|excel|xlsx)\b/i.test(t);
}

/** A report title from the question that asked for it. Exported for tests. */
export function reportTitleFromQuestion(text: string): string {
  const t = text
    .replace(/^\s*(create a downloadable report:\s*)/i, "")
    .replace(/^\s*(please\s+)?(can you\s+|could you\s+)?(give me|make|build|create|generate|export|download|show me)?\s*(me\s+)?(a\s+|an\s+|the\s+)?(downloadable\s+)?(report|export|spreadsheet|csv)?\s*(of|on|for|about|with)?\s*/i, "")
    .replace(/^(the|a|an|all)\s+/i, "")
    .replace(/[?.!]+$/, "")
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

function clipJson(value: unknown): string {
  const s = JSON.stringify(value);
  if (s.length <= TOOL_RESULT_MAX_CHARS) return s;
  return s.slice(0, TOOL_RESULT_MAX_CHARS) + '…"(truncated — narrow the filters or use create_report)"';
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
  emit: AssistantEmit;
  signal: AbortSignal;
}): Promise<void> {
  const { req, integration, emit, signal } = input;
  if (!integration.config?.host) throw new AppError(409, `The "${integration.name}" integration has no host`);
  // A blank Model means "the server's default pick" (resolveChatModel); a
  // server that cannot be listed fails here, before the question is stored.
  const config: LlmConfig = { ...integration.config, model: await resolveChatModel(integration.id, integration.config) };

  const { question } = await beginTurn(input.userId, input.conversationId, {
    content: input.content,
    regenerate: input.regenerate,
    integrationId: integration.id,
  });
  // Ownership passed and the question is stored: the route opens the stream
  // on this event, so its keep-alive covers a slow first token.
  emit("start", { question });

  const [turns, advisor] = await Promise.all([
    recentTurns(input.conversationId, config.contextMessages ?? LLM_DEFAULTS.contextMessages),
    getEfficiencyAdvisor(input.userId),
  ]);
  // What the turn did, for the Efficiency Advisor's sign-off (rule 95(h)).
  // Gathered whether or not the advisor is on; it costs a regex per lookup.
  const signals: TurnSignals = {
    question, outage: asksAboutOutage(question), failed: false,
    denied: false, usedHelp: false, lookedUp: false, found: false,
  };
  const recentLines = advisor ? await recentAdvisorLines(input.conversationId) : null;
  // The line shown when the first lookup starts; retracted on an outage.
  let preface: string | null = null;
  let prefaceOffered = false;
  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt({ username: input.username, extra: config.systemPromptExtra, displayName: config.displayName }) },
    ...turns,
  ];
  const tools = assistantToolDefs();
  const wantsReport = asksForReport(question);
  const reportOnlyTools = tools.filter((t) => t.function.name === "create_report");
  const wantsHowTo = !wantsReport && asksHowTo(question);
  const helpOnlyTools = tools.filter((t) => t.function.name === "search_help");
  let lastListCall: { name: string; args: string } | null = null;
  const toolNames = tools.map((t) => t.function.name);
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
        : tools;
      const res = await chatCompletionRound(config, messages, roundTools, { signal, onText });
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

      messages.push({ role: "assistant", content: spoke ? roundText : null, tool_calls: calls });
      // A round that spoke before calling tools ("Let me check…") gets a
      // paragraph break so the next round's text doesn't run on.
      if (spoke && !answer.endsWith("\n")) onText("\n\n");

      for (const tc of calls) {
        if (signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
        const name = tc.function.name;
        if (recentLines && !prefaceOffered && !signals.outage) {
          preface = pickLookupLine(recentLines.prefaces);
          emit("preface", { text: preface });
        }
        prefaceOffered = true;
        emit("tool", { name, label: toolLabel(name), status: "running" });
        const result = await runAssistantTool(name, tc.function.arguments, toolCtx);
        toolsUsed.push({ name, label: toolLabel(name), ok: result.ok });
        emit("tool", { name, label: toolLabel(name), status: "done", ok: result.ok });
        const content = clipJson(result.data);
        messages.push({ role: "tool", tool_call_id: tc.id, content });
        if (result.ok && REPORT_SOURCES.has(name)) lastListCall = { name, args: tc.function.arguments };
        noteLookup(signals, name, result, content);
        if (preface && signals.outage) {
          preface = null;
          emit("preface", { text: null });
        }
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
    const clean = sanitizeAnswerLinks(answer, await wikiPageNames());
    if (clean !== answer) {
      answer = clean;
      emit("retract", { from: 0 });
      emit("token", { text: answer });
    }
  }

  // The Efficiency Advisor sign-off (rule 95(h)): picked here, never written
  // by the model; none after an outage, an error or a Stop.
  let signOff: string | null = null;
  if (recentLines && (answer.trim() || reports.length)) {
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
    details: { tools: toolsUsed.map((t) => t.name), reports: reports.length, stopped },
  });

  if (failure) emit("error", { message: failure, messageId });
  else emit("done", { messageId, stopped });
}
