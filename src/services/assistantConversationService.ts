/**
 * src/services/assistantConversationService.ts — the AI assistant's saved
 * conversations (business rule 94(d)–(e)).
 *
 * OWNER-ONLY. Every function takes the session user's id and scopes every
 * query to it; a conversation id that belongs to someone else answers 404
 * (never 403 — which conversations exist is not something to confirm).
 * Admins get no exception: a conversation holds whatever its owner could see,
 * so it is that owner's data.
 *
 * Only the user / assistant turns are stored. Tool calls and their results are
 * NOT — they are re-derived on every request, so a stored conversation can
 * never replay data its owner has since lost access to. Report snapshots ARE
 * stored (rule 94(c)): reopening a conversation downloads the figures the user
 * saw at the time.
 *
 * Retention: `assistant.retentionDays` (default 90); pruneAssistantConversations
 * runs from the hourly pruneEvents job as one batched deleteMany.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import type { AssistantReportPayload } from "./assistantToolService.js";

const SETTINGS_KEY = "assistant";
const DEFAULT_RETENTION_DAYS = 90;
const TITLE_MAX = 120;
/** Per-user cap on stored conversations; the oldest are dropped past it. */
const MAX_CONVERSATIONS_PER_USER = 200;

export interface AssistantSettings {
  retentionDays: number;
}

export interface ToolUseRecord {
  name: string;
  label: string;
  ok: boolean;
}

export async function getAssistantSettings(): Promise<AssistantSettings> {
  const row = await prisma.setting.findUnique({ where: { key: SETTINGS_KEY } });
  const days = Number((row?.value as Record<string, unknown> | undefined)?.retentionDays);
  return { retentionDays: Number.isFinite(days) && days >= 1 ? Math.min(Math.floor(days), 3650) : DEFAULT_RETENTION_DAYS };
}

export async function updateAssistantSettings(input: Partial<AssistantSettings>): Promise<AssistantSettings> {
  const days = Number(input.retentionDays);
  if (!Number.isFinite(days) || days < 1 || days > 3650) {
    throw new AppError(400, "Conversation retention must be between 1 and 3650 days");
  }
  const value = { retentionDays: Math.floor(days) };
  await prisma.setting.upsert({ where: { key: SETTINGS_KEY }, create: { key: SETTINGS_KEY, value }, update: { value } });
  return value;
}

/** First line of the opening question, trimmed to a title. Exported for tests. */
export function titleFromQuestion(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (!line) return "New conversation";
  return line.length > 60 ? line.slice(0, 57).trimEnd() + "…" : line;
}

async function ownedOrThrow(userId: string, id: string) {
  const conv = await prisma.assistantConversation.findFirst({ where: { id, userId }, select: { id: true, title: true } });
  if (!conv) throw new AppError(404, "Conversation not found");
  return conv;
}

export async function listConversations(userId: string, limit = 50) {
  return prisma.assistantConversation.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    take: Math.min(Math.max(limit, 1), MAX_CONVERSATIONS_PER_USER),
    select: { id: true, title: true, createdAt: true, updatedAt: true, _count: { select: { messages: true } } },
  }).then((rows) => rows.map(({ _count, ...r }) => ({ ...r, messageCount: _count.messages })));
}

export async function createConversation(userId: string, title?: string) {
  const conv = await prisma.assistantConversation.create({
    data: { userId, title: title ? title.trim().slice(0, TITLE_MAX) || "New conversation" : "New conversation" },
    select: { id: true, title: true, createdAt: true, updatedAt: true },
  });
  // Keep one user's history bounded without a job: past the cap, drop the oldest.
  const overflow = await prisma.assistantConversation.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    skip: MAX_CONVERSATIONS_PER_USER,
    select: { id: true },
  });
  if (overflow.length) {
    await prisma.assistantConversation.deleteMany({ where: { id: { in: overflow.map((o) => o.id) } } });
  }
  return conv;
}

export async function getConversation(userId: string, id: string) {
  const conv = await prisma.assistantConversation.findFirst({
    where: { id, userId },
    select: {
      id: true, title: true, integrationId: true, createdAt: true, updatedAt: true,
      messages: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true, role: true, content: true, toolsUsed: true, stopped: true, createdAt: true,
          reports: {
            orderBy: { generatedAt: "asc" },
            select: { id: true, title: true, columns: true, rows: true, rowCount: true, truncated: true, generatedAt: true },
          },
        },
      },
    },
  });
  if (!conv) throw new AppError(404, "Conversation not found");
  return conv;
}

export async function renameConversation(userId: string, id: string, title: string) {
  await ownedOrThrow(userId, id);
  const clean = title.replace(/\s+/g, " ").trim().slice(0, TITLE_MAX);
  if (!clean) throw new AppError(400, "Title cannot be empty");
  return prisma.assistantConversation.update({ where: { id }, data: { title: clean }, select: { id: true, title: true, updatedAt: true } });
}

export async function deleteConversation(userId: string, id: string): Promise<void> {
  await ownedOrThrow(userId, id);
  await prisma.assistantConversation.delete({ where: { id } });
}

/** /clear — empty the thread but keep it (and its title reset). */
export async function clearConversation(userId: string, id: string): Promise<void> {
  await ownedOrThrow(userId, id);
  await prisma.$transaction([
    prisma.assistantMessage.deleteMany({ where: { conversationId: id } }),
    prisma.assistantConversation.update({ where: { id }, data: { title: "New conversation" } }),
  ]);
}

/**
 * The last `n` turns, oldest first — what is resent to the model. Older turns
 * stay saved and visible but are not resent, which keeps a small local
 * model's context window from overflowing.
 */
export async function recentTurns(conversationId: string, n: number): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
  const rows = await prisma.assistantMessage.findMany({
    where: { conversationId },
    orderBy: { createdAt: "desc" },
    take: Math.max(n, 1),
    select: { role: true, content: true },
  });
  return rows.reverse().map((r) => ({ role: r.role === "assistant" ? "assistant" : "user", content: r.content }));
}

/**
 * Start a turn: verify ownership, store the user's message (or, for /retry,
 * drop the previous answer and reuse the last question), and title a fresh
 * thread from its first question. Returns the question being answered.
 */
export async function beginTurn(
  userId: string,
  conversationId: string,
  input: { content?: string; regenerate?: boolean; integrationId: string },
): Promise<{ question: string }> {
  const conv = await ownedOrThrow(userId, conversationId);
  if (input.regenerate) {
    const last = await prisma.assistantMessage.findMany({
      where: { conversationId },
      orderBy: { createdAt: "desc" },
      take: 2,
      select: { id: true, role: true, content: true },
    });
    const lastUser = last.find((m) => m.role === "user");
    if (!lastUser) throw new AppError(400, "Nothing to retry yet");
    const lastAssistant = last[0]?.role === "assistant" ? last[0] : null;
    if (lastAssistant) await prisma.assistantMessage.delete({ where: { id: lastAssistant.id } });
    await prisma.assistantConversation.update({ where: { id: conversationId }, data: { integrationId: input.integrationId } });
    return { question: lastUser.content };
  }
  const content = (input.content ?? "").trim();
  if (!content) throw new AppError(400, "Message is empty");
  const isFirst = (await prisma.assistantMessage.count({ where: { conversationId } })) === 0;
  await prisma.$transaction([
    prisma.assistantMessage.create({ data: { conversationId, role: "user", content } }),
    prisma.assistantConversation.update({
      where: { id: conversationId },
      data: {
        integrationId: input.integrationId,
        ...(isFirst && conv.title === "New conversation" ? { title: titleFromQuestion(content) } : {}),
      },
    }),
  ]);
  return { question: content };
}

/** Store the assistant's answer (whole, or partial with stopped=true) and its reports. */
export async function finishTurn(
  conversationId: string,
  answer: { content: string; toolsUsed: ToolUseRecord[]; stopped: boolean; reports: AssistantReportPayload[] },
): Promise<{ messageId: string; reportIds: string[] }> {
  const message = await prisma.assistantMessage.create({
    data: {
      conversationId,
      role: "assistant",
      content: answer.content,
      toolsUsed: answer.toolsUsed as never,
      stopped: answer.stopped,
    },
    select: { id: true },
  });
  const reportIds: string[] = [];
  for (const r of answer.reports) {
    const row = await prisma.assistantReport.create({
      data: {
        messageId: message.id,
        title: r.title.slice(0, 200),
        columns: r.columns as never,
        rows: r.rows as never,
        rowCount: r.rowCount,
        truncated: r.truncated,
      },
      select: { id: true },
    });
    reportIds.push(row.id);
  }
  await prisma.assistantConversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } });
  return { messageId: message.id, reportIds };
}

/** Rule 94(e): drop conversations idle past the retention window. One batched delete. */
export async function pruneAssistantConversations(): Promise<number> {
  const { retentionDays } = await getAssistantSettings();
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
  const { count } = await prisma.assistantConversation.deleteMany({ where: { updatedAt: { lt: cutoff } } });
  if (count > 0) logger.info({ count, retentionDays }, "Pruned idle assistant conversations");
  return count;
}
