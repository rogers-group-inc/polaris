/**
 * src/services/assistantConversationService.ts — the AI assistant's saved
 * conversations (business rule 95(d)–(e)).
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
 * stored (rule 95(c)): reopening a conversation downloads the figures the user
 * saw at the time.
 *
 * Retention: `assistant.retentionDays` (default 90); pruneAssistantConversations
 * runs from the hourly pruneEvents job as one batched deleteMany.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { logEvent } from "./eventLogService.js";
import type { AssistantReportPayload } from "./assistantToolService.js";

const SETTINGS_KEY = "assistant";
const DEFAULT_RETENTION_DAYS = 90;
const TITLE_MAX = 120;
/** Per-user cap on stored conversations; the oldest are dropped past it. */
const MAX_CONVERSATIONS_PER_USER = 200;

/**
 * Screenshots on a user turn (rule 95(l)). 3.5 MiB keeps one image under
 * Anthropic's 5 MB base64 ceiling; the widget downsizes a paste to 1568 px on
 * its long edge first, so a real screenshot is far smaller.
 */
export const IMAGE_LIMITS = { perMessage: 4, maxBytes: 3.5 * 1024 * 1024 } as const;

/**
 * The image type from the file's own leading bytes — PNG, JPEG, WebP or GIF,
 * the four every vision model reads. Null for anything else, whatever the
 * upload claimed to be. Exported for tests.
 */
export function sniffImageType(buf: Buffer): string | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.toString("ascii", 0, 6))) return "image/gif";
  return null;
}

/** Check and type a turn's uploads; 400 naming the first one refused. */
function checkedImages(images: Buffer[]): Array<{ mimeType: string; bytes: Buffer }> {
  if (images.length > IMAGE_LIMITS.perMessage) {
    throw new AppError(400, `At most ${IMAGE_LIMITS.perMessage} images per message`);
  }
  return images.map((bytes, i) => {
    if (bytes.length > IMAGE_LIMITS.maxBytes) throw new AppError(413, `Image ${i + 1} is larger than 3.5 MB`);
    const mimeType = sniffImageType(bytes);
    if (!mimeType) throw new AppError(400, `Image ${i + 1} is not a PNG, JPEG, WebP or GIF`);
    return { mimeType, bytes };
  });
}

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

export async function updateAssistantSettings(input: Partial<AssistantSettings>, actor = "unknown"): Promise<AssistantSettings> {
  const days = Number(input.retentionDays);
  if (!Number.isFinite(days) || days < 1 || days > 3650) {
    throw new AppError(400, "Conversation retention must be between 1 and 3650 days");
  }
  const before = await getAssistantSettings();
  const value = { retentionDays: Math.floor(days) };
  await prisma.setting.upsert({ where: { key: SETTINGS_KEY }, create: { key: SETTINGS_KEY, value }, update: { value } });
  if (before.retentionDays !== value.retentionDays) {
    await logEvent({
      action: "assistant.settings.updated",
      resourceType: "setting",
      resourceId: SETTINGS_KEY,
      resourceName: "AI assistant",
      actor,
      // Shortening it deletes saved conversations at the next daily prune.
      level: value.retentionDays < before.retentionDays ? "warning" : "info",
      message: `AI assistant conversation retention changed from ${before.retentionDays} to ${value.retentionDays} days`,
      details: { from: before.retentionDays, to: value.retentionDays },
    });
  }
  return value;
}

/** The caller's Efficiency Advisor checkbox (rule 95(h)). */
export async function getEfficiencyAdvisor(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { assistantEfficiencyAdvisor: true } });
  return user?.assistantEfficiencyAdvisor === true;
}

export async function setEfficiencyAdvisor(userId: string, on: boolean): Promise<boolean> {
  const user = await prisma.user.update({
    where: { id: userId },
    data: { assistantEfficiencyAdvisor: on },
    select: { assistantEfficiencyAdvisor: true },
  });
  return user.assistantEfficiencyAdvisor;
}

/**
 * The Efficiency Advisor lines of this conversation's last `n` answers,
 * newest first — so a line is not repeated back to back.
 */
export async function recentAdvisorLines(conversationId: string, n = 5): Promise<{ prefaces: string[]; signOffs: string[] }> {
  const rows = await prisma.assistantMessage.findMany({
    where: { conversationId, role: "assistant" },
    orderBy: { createdAt: "desc" },
    take: n,
    select: { preface: true, signOff: true },
  });
  return {
    prefaces: rows.flatMap((r) => (r.preface ? [r.preface] : [])),
    signOffs: rows.flatMap((r) => (r.signOff ? [r.signOff] : [])),
  };
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
          id: true, role: true, content: true, toolsUsed: true, stopped: true, preface: true, signOff: true, createdAt: true,
          // Ids only — the bytes are fetched one by one (getConversationImage).
          images: { orderBy: { position: "asc" }, select: { id: true, mimeType: true } },
          reports: {
            orderBy: { generatedAt: "asc" },
            select: { id: true, title: true, columns: true, rows: true, rowCount: true, truncated: true, formats: true, generatedAt: true },
          },
        },
      },
    },
  });
  if (!conv) throw new AppError(404, "Conversation not found");
  return conv;
}

/** One pasted image, owner-scoped like its conversation (404 for anyone else's). */
export async function getConversationImage(userId: string, conversationId: string, imageId: string): Promise<{ mimeType: string; bytes: Buffer }> {
  const img = await prisma.assistantMessageImage.findFirst({
    where: { id: imageId, message: { conversationId, conversation: { userId } } },
    select: { mimeType: true, bytes: true },
  });
  if (!img) throw new AppError(404, "Image not found");
  return { mimeType: img.mimeType, bytes: Buffer.from(img.bytes) };
}

/** The bytes of the given images, base64 for the model, keyed by id. */
export async function loadTurnImages(ids: string[]): Promise<Map<string, { mimeType: string; base64: string }>> {
  if (!ids.length) return new Map();
  const rows = await prisma.assistantMessageImage.findMany({
    where: { id: { in: ids } },
    select: { id: true, mimeType: true, bytes: true },
  });
  return new Map(rows.map((r) => [r.id, { mimeType: r.mimeType, base64: Buffer.from(r.bytes).toString("base64") }]));
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
export async function recentTurns(conversationId: string, n: number): Promise<Array<{ role: "user" | "assistant"; content: string; imageIds?: string[] }>> {
  const rows = await prisma.assistantMessage.findMany({
    where: { conversationId },
    orderBy: { createdAt: "desc" },
    take: Math.max(n, 1),
    // Image ids only: the chat service decides which are resent (rule 95(l)) and loads just those.
    select: { role: true, content: true, images: { orderBy: { position: "asc" }, select: { id: true } } },
  });
  return rows.reverse().map((r) => ({
    role: r.role === "assistant" ? "assistant" : "user",
    content: r.content,
    ...(r.images?.length ? { imageIds: r.images.map((i) => i.id) } : {}),
  }));
}

/**
 * Start a turn: verify ownership, store the user's message (or, for /retry,
 * drop the previous answer and reuse the last question), and title a fresh
 * thread from its first question. Returns the question being answered.
 */
export async function beginTurn(
  userId: string,
  conversationId: string,
  input: { content?: string; regenerate?: boolean; integrationId: string; images?: Buffer[] },
): Promise<{ question: string; images: Array<{ id: string; mimeType: string }> }> {
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
    // Its images are already stored on it; recentTurns brings them back.
    return { question: lastUser.content, images: [] };
  }
  const content = (input.content ?? "").trim();
  const images = checkedImages(input.images ?? []);
  if (!content && !images.length) throw new AppError(400, "Message is empty");
  const isFirst = (await prisma.assistantMessage.count({ where: { conversationId } })) === 0;
  const title = content ? titleFromQuestion(content) : images.length === 1 ? "Screenshot" : "Screenshots";
  const [message] = await prisma.$transaction([
    prisma.assistantMessage.create({
      data: {
        conversationId,
        role: "user",
        content,
        ...(images.length
          ? { images: { create: images.map((img, i) => ({ mimeType: img.mimeType, bytes: new Uint8Array(img.bytes), sizeBytes: img.bytes.length, position: i })) } }
          : {}),
      },
      select: { images: { orderBy: { position: "asc" }, select: { id: true, mimeType: true } } },
    }),
    prisma.assistantConversation.update({
      where: { id: conversationId },
      data: {
        integrationId: input.integrationId,
        ...(isFirst && conv.title === "New conversation" ? { title } : {}),
      },
    }),
  ]);
  return { question: content, images: message.images ?? [] };
}

/** Store the assistant's answer (whole, or partial with stopped=true), its Efficiency Advisor lines and its reports. */
export async function finishTurn(
  conversationId: string,
  answer: {
    content: string; toolsUsed: ToolUseRecord[]; stopped: boolean; reports: AssistantReportPayload[];
    preface?: string | null; signOff?: string | null;
  },
): Promise<{ messageId: string; reportIds: string[] }> {
  const message = await prisma.assistantMessage.create({
    data: {
      conversationId,
      role: "assistant",
      content: answer.content,
      toolsUsed: answer.toolsUsed as never,
      stopped: answer.stopped,
      preface: answer.preface ?? null,
      signOff: answer.signOff ?? null,
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
        formats: r.formats ?? [],
      },
      select: { id: true },
    });
    reportIds.push(row.id);
  }
  await prisma.assistantConversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } });
  return { messageId: message.id, reportIds };
}

/** Rule 95(e): drop conversations idle past the retention window. One batched delete. */
export async function pruneAssistantConversations(): Promise<number> {
  const { retentionDays } = await getAssistantSettings();
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
  const { count } = await prisma.assistantConversation.deleteMany({ where: { updatedAt: { lt: cutoff } } });
  if (count > 0) logger.info({ count, retentionDays }, "Pruned idle assistant conversations");
  return count;
}
