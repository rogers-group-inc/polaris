/**
 * tests/unit/assistantConversationService.test.ts
 *
 * The AI assistant's saved conversations (business rule 95(d), (e), (h), (l), (n)):
 *   - owner-only: every read and write is scoped to the caller's id and a
 *     conversation that is not theirs answers 404, never 403;
 *   - only user / assistant turns are stored; recentTurns resends labels and
 *     counts, never report rows or the Efficiency Advisor's lines;
 *   - screenshots are typed by sniffing the bytes, at most 4 of 3.5 MiB;
 *   - retention: the `assistant` Setting (default 90 days), a warning Event
 *     when it shortens, and one batched deleteMany to prune.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) => import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
const lg = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("../../src/utils/logger.js", () => ({ logger: lg }));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
import { AppError } from "../../src/utils/errors.js";
import {
  IMAGE_LIMITS,
  sniffImageType,
  getAssistantSettings,
  updateAssistantSettings,
  getEfficiencyAdvisor,
  setEfficiencyAdvisor,
  recentAdvisorLines,
  listConversations,
  createConversation,
  getConversation,
  getConversationImage,
  loadTurnImages,
  renameConversation,
  deleteConversation,
  clearConversation,
  recentTurns,
  beginTurn,
  finishTurn,
  pruneAssistantConversations,
} from "../../src/services/assistantConversationService.js";

const conv = {
  findFirst: stubbed(prisma.assistantConversation.findFirst),
  findMany: stubbed(prisma.assistantConversation.findMany),
  create: stubbed(prisma.assistantConversation.create),
  update: stubbed(prisma.assistantConversation.update),
  delete: stubbed(prisma.assistantConversation.delete),
  deleteMany: stubbed(prisma.assistantConversation.deleteMany),
};
const msg = {
  findMany: stubbed(prisma.assistantMessage.findMany),
  create: stubbed(prisma.assistantMessage.create),
  delete: stubbed(prisma.assistantMessage.delete),
  deleteMany: stubbed(prisma.assistantMessage.deleteMany),
  count: stubbed(prisma.assistantMessage.count),
};
const img = {
  findFirst: stubbed(prisma.assistantMessageImage.findFirst),
  findMany: stubbed(prisma.assistantMessageImage.findMany),
};
const setting = {
  findUnique: stubbed(prisma.setting.findUnique),
  upsert: stubbed(prisma.setting.upsert),
};
const user = {
  findUnique: stubbed(prisma.user.findUnique),
  update: stubbed(prisma.user.update),
};
const report = { create: stubbed(prisma.assistantReport.create) };

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([1, 2, 3, 4]), Buffer.from("WEBP")]);
const GIF = Buffer.from("GIF89a....");

async function rejection(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (err) {
    return err as AppError;
  }
  throw new Error("expected a rejection");
}

/** The ownership lookup: owned → the row, not owned → null. */
function owns(title = "New conversation") {
  conv.findFirst.mockResolvedValue({ id: "c1", title });
}

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
  vi.clearAllMocks();
});

// ─── Image sniffing ───────────────────────────────────────────────────────

describe("sniffImageType", () => {
  it("names the four types every vision model reads", () => {
    expect(sniffImageType(PNG)).toBe("image/png");
    expect(sniffImageType(JPEG)).toBe("image/jpeg");
    expect(sniffImageType(WEBP)).toBe("image/webp");
    expect(sniffImageType(GIF)).toBe("image/gif");
    expect(sniffImageType(Buffer.from("GIF87a"))).toBe("image/gif");
  });

  it("returns null for anything else, including truncated headers", () => {
    expect(sniffImageType(Buffer.alloc(0))).toBeNull();
    expect(sniffImageType(PNG.subarray(0, 7))).toBeNull();
    expect(sniffImageType(Buffer.from([0xff, 0xd8]))).toBeNull();
    expect(sniffImageType(Buffer.from("RIFF....WAVE"))).toBeNull();
    expect(sniffImageType(Buffer.from("GIF88a"))).toBeNull();
    expect(sniffImageType(Buffer.from("<svg xmlns=...>"))).toBeNull();
    expect(sniffImageType(Buffer.from("%PDF-1.7"))).toBeNull();
  });

  it("caps a message at 4 images of 3.5 MiB", () => {
    expect(IMAGE_LIMITS).toEqual({ perMessage: 4, maxBytes: 3.5 * 1024 * 1024 });
  });
});

// ─── Settings ─────────────────────────────────────────────────────────────

describe("getAssistantSettings", () => {
  it("defaults to 90 days with no row, a non-number or a value under 1", async () => {
    setting.findUnique.mockResolvedValueOnce(null);
    expect(await getAssistantSettings()).toEqual({ retentionDays: 90 });
    setting.findUnique.mockResolvedValueOnce({ value: { retentionDays: "abc" } });
    expect(await getAssistantSettings()).toEqual({ retentionDays: 90 });
    setting.findUnique.mockResolvedValueOnce({ value: { retentionDays: 0 } });
    expect(await getAssistantSettings()).toEqual({ retentionDays: 90 });
    setting.findUnique.mockResolvedValueOnce({ value: {} });
    expect(await getAssistantSettings()).toEqual({ retentionDays: 90 });
  });

  it("floors a fraction and caps at 3650", async () => {
    setting.findUnique.mockResolvedValueOnce({ value: { retentionDays: 30.9 } });
    expect(await getAssistantSettings()).toEqual({ retentionDays: 30 });
    setting.findUnique.mockResolvedValueOnce({ value: { retentionDays: 99999 } });
    expect(await getAssistantSettings()).toEqual({ retentionDays: 3650 });
    setting.findUnique.mockResolvedValueOnce({ value: { retentionDays: "14" } });
    expect(await getAssistantSettings()).toEqual({ retentionDays: 14 });
  });

  it("reads the `assistant` key", async () => {
    setting.findUnique.mockResolvedValueOnce(null);
    await getAssistantSettings();
    expect(setting.findUnique).toHaveBeenCalledWith({ where: { key: "assistant" } });
  });
});

describe("updateAssistantSettings", () => {
  it("refuses a value outside 1..3650 with 400 and writes nothing", async () => {
    for (const bad of [0, -5, 3651, Number.NaN, undefined]) {
      const err = await rejection(updateAssistantSettings({ retentionDays: bad as number }, "alice"));
      expect(err).toBeInstanceOf(AppError);
      expect(err.httpStatus).toBe(400);
    }
    expect(setting.upsert).not.toHaveBeenCalled();
  });

  it("upserts the floored value and returns it", async () => {
    setting.findUnique.mockResolvedValue({ value: { retentionDays: 90 } });
    expect(await updateAssistantSettings({ retentionDays: 45.7 }, "alice")).toEqual({ retentionDays: 45 });
    expect(setting.upsert).toHaveBeenCalledWith({
      where: { key: "assistant" },
      create: { key: "assistant", value: { retentionDays: 45 } },
      update: { value: { retentionDays: 45 } },
    });
  });

  it("logs a WARNING when retention shortens (the next prune deletes conversations)", async () => {
    setting.findUnique.mockResolvedValue({ value: { retentionDays: 90 } });
    await updateAssistantSettings({ retentionDays: 30 }, "alice");
    expect(eventLog.logEvent).toHaveBeenCalledTimes(1);
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({
      action: "assistant.settings.updated",
      resourceType: "setting",
      resourceId: "assistant",
      actor: "alice",
      level: "warning",
      details: { from: 90, to: 30 },
    });
  });

  it("logs info when it lengthens, nothing when unchanged", async () => {
    setting.findUnique.mockResolvedValue({ value: { retentionDays: 30 } });
    await updateAssistantSettings({ retentionDays: 365 });
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({ level: "info", actor: "unknown", details: { from: 30, to: 365 } });
    eventLog.logEvent.mockClear();
    setting.findUnique.mockResolvedValue({ value: { retentionDays: 365 } });
    await updateAssistantSettings({ retentionDays: 365 });
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });
});

// ─── Efficiency Advisor ───────────────────────────────────────────────────

describe("Efficiency Advisor preference", () => {
  it("is true only when the column is exactly true", async () => {
    user.findUnique.mockResolvedValueOnce({ assistantEfficiencyAdvisor: true });
    expect(await getEfficiencyAdvisor("u1")).toBe(true);
    user.findUnique.mockResolvedValueOnce({ assistantEfficiencyAdvisor: false });
    expect(await getEfficiencyAdvisor("u1")).toBe(false);
    user.findUnique.mockResolvedValueOnce(null);
    expect(await getEfficiencyAdvisor("missing")).toBe(false);
  });

  it("sets the caller's own flag and returns the stored value", async () => {
    user.update.mockResolvedValue({ assistantEfficiencyAdvisor: true });
    expect(await setEfficiencyAdvisor("u1", true)).toBe(true);
    expect(user.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "u1" }, data: { assistantEfficiencyAdvisor: true } }));
  });

  it("recentAdvisorLines returns the last answers' non-empty lines, newest first", async () => {
    msg.findMany.mockResolvedValue([
      { preface: "P3", signOff: null },
      { preface: null, signOff: "S2" },
      { preface: "", signOff: "S1" },
    ]);
    expect(await recentAdvisorLines("c1", 3)).toEqual({ prefaces: ["P3"], signOffs: ["S2", "S1"] });
    expect(msg.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { conversationId: "c1", role: "assistant" },
      orderBy: { createdAt: "desc" },
      take: 3,
    }));
  });

  it("recentAdvisorLines defaults to the last 5", async () => {
    msg.findMany.mockResolvedValue([]);
    expect(await recentAdvisorLines("c1")).toEqual({ prefaces: [], signOffs: [] });
    expect(msg.findMany.mock.calls[0][0].take).toBe(5);
  });
});

// ─── List / create / get ──────────────────────────────────────────────────

describe("listConversations", () => {
  it("lists only the caller's, newest first, with a message count", async () => {
    const at = new Date();
    conv.findMany.mockResolvedValue([{ id: "c1", title: "T", createdAt: at, updatedAt: at, _count: { messages: 4 } }]);
    expect(await listConversations("u1")).toEqual([{ id: "c1", title: "T", createdAt: at, updatedAt: at, messageCount: 4 }]);
    const arg = conv.findMany.mock.calls[0][0];
    expect(arg.where).toEqual({ userId: "u1" });
    expect(arg.orderBy).toEqual({ updatedAt: "desc" });
    expect(arg.take).toBe(50);
  });

  it("clamps the limit to 1..200", async () => {
    conv.findMany.mockResolvedValue([]);
    await listConversations("u1", 0);
    await listConversations("u1", 10_000);
    expect(conv.findMany.mock.calls[0][0].take).toBe(1);
    expect(conv.findMany.mock.calls[1][0].take).toBe(200);
  });

  it("takes the default 50 for a non-finite limit", async () => {
    // Was a bug until 2026-11-16: listConversations(userId, NaN) passed take: NaN.
    conv.findMany.mockResolvedValue([]);
    await listConversations("u1", Number.NaN);
    expect(conv.findMany.mock.calls[0][0].take).toBe(50);
  });
});

describe("createConversation", () => {
  beforeEach(() => {
    conv.create.mockImplementation(async ({ data }: any) => ({ id: "new", title: data.title }));
    conv.findMany.mockResolvedValue([]);
  });

  it("titles a thread from the given title, trimmed and capped at 120", async () => {
    await createConversation("u1", "  Weekly report  ");
    expect(conv.create.mock.calls[0][0].data).toEqual({ userId: "u1", title: "Weekly report" });
    await createConversation("u1", "x".repeat(200));
    expect(conv.create.mock.calls[1][0].data.title).toHaveLength(120);
  });

  it("collapses inner whitespace in the title, as rename does", async () => {
    // Was a bug until 2026-11-16: create only trimmed, so "Weekly\n\n  report" was stored as typed.
    await createConversation("u1", "Weekly\n\n  report");
    expect(conv.create.mock.calls[0][0].data.title).toBe("Weekly report");
  });

  it("falls back to 'New conversation' for no title or a blank one", async () => {
    await createConversation("u1");
    await createConversation("u1", "   ");
    expect(conv.create.mock.calls[0][0].data.title).toBe("New conversation");
    expect(conv.create.mock.calls[1][0].data.title).toBe("New conversation");
  });

  it("does not delete anything while the user is under the 200 cap", async () => {
    await createConversation("u1");
    expect(conv.findMany.mock.calls[0][0]).toMatchObject({ where: { userId: "u1" }, orderBy: { updatedAt: "desc" }, skip: 200 });
    expect(conv.deleteMany).not.toHaveBeenCalled();
  });

  it("drops that user's oldest past the cap, in one deleteMany", async () => {
    conv.findMany.mockResolvedValue([{ id: "old1" }, { id: "old2" }]);
    const out = await createConversation("u1", "Hi");
    expect(out).toEqual({ id: "new", title: "Hi" });
    expect(conv.deleteMany).toHaveBeenCalledTimes(1);
    expect(conv.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["old1", "old2"] } } });
  });
});

describe("getConversation", () => {
  it("scopes by id AND owner and 404s anyone else's", async () => {
    conv.findFirst.mockResolvedValue(null);
    const err = await rejection(getConversation("u2", "c1"));
    expect(err.httpStatus).toBe(404);
    expect(conv.findFirst.mock.calls[0][0].where).toEqual({ id: "c1", userId: "u2" });
  });

  it("returns image ids and types, never bytes", async () => {
    conv.findFirst.mockResolvedValue({ id: "c1", messages: [] });
    await getConversation("u1", "c1");
    const images = conv.findFirst.mock.calls[0][0].select.messages.select.images.select;
    expect(images).toEqual({ id: true, mimeType: true });
  });
});

describe("getConversationImage", () => {
  it("scopes through message → conversation → owner and returns a Buffer", async () => {
    img.findFirst.mockResolvedValue({ mimeType: "image/png", bytes: new Uint8Array([1, 2, 3]) });
    const out = await getConversationImage("u1", "c1", "i1");
    expect(out.mimeType).toBe("image/png");
    expect(Buffer.isBuffer(out.bytes)).toBe(true);
    expect([...out.bytes]).toEqual([1, 2, 3]);
    expect(img.findFirst.mock.calls[0][0].where).toEqual({ id: "i1", message: { conversationId: "c1", conversation: { userId: "u1" } } });
  });

  it("404s an image that is not the caller's", async () => {
    img.findFirst.mockResolvedValue(null);
    expect((await rejection(getConversationImage("u2", "c1", "i1"))).httpStatus).toBe(404);
  });
});

describe("loadTurnImages", () => {
  it("returns an empty map without a query for no ids", async () => {
    expect((await loadTurnImages([])).size).toBe(0);
    expect(img.findMany).not.toHaveBeenCalled();
  });

  it("returns base64 keyed by id", async () => {
    img.findMany.mockResolvedValue([
      { id: "a", mimeType: "image/png", bytes: new Uint8Array([104, 105]) },
      { id: "b", mimeType: "image/gif", bytes: new Uint8Array([0]) },
    ]);
    const out = await loadTurnImages(["a", "b"]);
    expect(out.get("a")).toEqual({ mimeType: "image/png", base64: "aGk=" });
    expect(out.get("b")).toEqual({ mimeType: "image/gif", base64: "AA==" });
    expect(img.findMany.mock.calls[0][0].where).toEqual({ id: { in: ["a", "b"] } });
  });
});

// ─── Rename / delete / clear ──────────────────────────────────────────────

describe("rename / delete / clear", () => {
  it("rename collapses whitespace, caps at 120 and updates the owned row", async () => {
    owns();
    conv.update.mockResolvedValue({ id: "c1", title: "A B" });
    await renameConversation("u1", "c1", "  A \n\t B ");
    expect(conv.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "c1" }, data: { title: "A B" } }));
    await renameConversation("u1", "c1", "y".repeat(300));
    expect(conv.update.mock.calls[1][0].data.title).toHaveLength(120);
  });

  it("rename refuses an empty title with 400", async () => {
    owns();
    const err = await rejection(renameConversation("u1", "c1", " \n "));
    expect(err.httpStatus).toBe(400);
    expect(conv.update).not.toHaveBeenCalled();
  });

  it("every write 404s a conversation the caller does not own, before touching it", async () => {
    conv.findFirst.mockResolvedValue(null);
    expect((await rejection(renameConversation("u2", "c1", "x"))).httpStatus).toBe(404);
    expect((await rejection(deleteConversation("u2", "c1"))).httpStatus).toBe(404);
    expect((await rejection(clearConversation("u2", "c1"))).httpStatus).toBe(404);
    expect((await rejection(beginTurn("u2", "c1", { content: "hi", integrationId: "i" }))).httpStatus).toBe(404);
    for (const call of conv.findFirst.mock.calls) expect(call[0].where).toEqual({ id: "c1", userId: "u2" });
    expect(conv.update).not.toHaveBeenCalled();
    expect(conv.delete).not.toHaveBeenCalled();
    expect(msg.deleteMany).not.toHaveBeenCalled();
    expect(msg.create).not.toHaveBeenCalled();
  });

  it("delete removes the owned row", async () => {
    owns();
    await deleteConversation("u1", "c1");
    expect(conv.delete).toHaveBeenCalledWith({ where: { id: "c1" } });
  });

  it("clear empties the messages and resets the title in one transaction", async () => {
    owns("Old title");
    await clearConversation("u1", "c1");
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(msg.deleteMany).toHaveBeenCalledWith({ where: { conversationId: "c1" } });
    expect(conv.update).toHaveBeenCalledWith({ where: { id: "c1" }, data: { title: "New conversation" } });
  });
});

// ─── recentTurns ──────────────────────────────────────────────────────────

describe("recentTurns", () => {
  const t1 = new Date("2026-11-01T10:00:00Z");
  const t2 = new Date("2026-11-01T10:01:00Z");

  it("returns the last n turns oldest first", async () => {
    msg.findMany.mockResolvedValue([
      { role: "assistant", content: "A", createdAt: t2, toolsUsed: [{ name: "list_assets", label: "Assets", ok: true }], images: [], reports: [{ title: "R", rowCount: 3 }] },
      { role: "user", content: "Q", createdAt: t1, toolsUsed: null, images: [{ id: "i1" }, { id: "i2" }], reports: [] },
    ]);
    const out = await recentTurns("c1", 2);
    expect(out).toEqual([
      { role: "user", content: "Q", createdAt: t1, toolsUsed: [], reports: [], imageIds: ["i1", "i2"] },
      { role: "assistant", content: "A", createdAt: t2, toolsUsed: [{ name: "list_assets", label: "Assets", ok: true }], reports: [{ title: "R", rowCount: 3 }] },
    ]);
    const arg = msg.findMany.mock.calls[0][0];
    expect(arg.orderBy).toEqual({ createdAt: "desc" });
    expect(arg.take).toBe(2);
  });

  it("never selects report rows or the Efficiency Advisor lines (rule 95(h), (n))", async () => {
    msg.findMany.mockResolvedValue([]);
    await recentTurns("c1", 10);
    const select = msg.findMany.mock.calls[0][0].select;
    expect(select.preface).toBeUndefined();
    expect(select.signOff).toBeUndefined();
    expect(select.reports.select).toEqual({ title: true, rowCount: true });
    expect(select.images.select).toEqual({ id: true });
  });

  it("asks for at least one turn and maps an unknown role to user", async () => {
    msg.findMany.mockResolvedValue([{ role: "system", content: "x", createdAt: t1, toolsUsed: "junk", reports: undefined, images: undefined }]);
    const out = await recentTurns("c1", 0);
    expect(msg.findMany.mock.calls[0][0].take).toBe(1);
    expect(out).toEqual([{ role: "user", content: "x", createdAt: t1, toolsUsed: [], reports: [] }]);
  });
});

// ─── beginTurn ────────────────────────────────────────────────────────────

describe("beginTurn — a new question", () => {
  beforeEach(() => {
    msg.count.mockResolvedValue(0);
    msg.create.mockResolvedValue({ images: [] });
    conv.update.mockResolvedValue({});
  });

  it("stores the trimmed question and titles a fresh thread from it", async () => {
    owns();
    const out = await beginTurn("u1", "c1", { content: "  Why is sw1 down?  ", integrationId: "llm1" });
    expect(out).toEqual({ question: "Why is sw1 down?", images: [] });
    expect(msg.create.mock.calls[0][0].data).toEqual({ conversationId: "c1", role: "user", content: "Why is sw1 down?" });
    expect(conv.update.mock.calls[0][0]).toEqual({ where: { id: "c1" }, data: { integrationId: "llm1", title: "Why is sw1 down?" } });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it("shortens a long question's title to 57 characters + an ellipsis", async () => {
    owns();
    await beginTurn("u1", "c1", { content: "word ".repeat(30), integrationId: "llm1" });
    const title = conv.update.mock.calls[0][0].data.title as string;
    expect(title.endsWith("…")).toBe(true);
    expect(title.length).toBeLessThanOrEqual(58);
    expect(title).not.toMatch(/\s…$/);
  });

  it("keeps the title of a thread that already has messages or was named", async () => {
    owns();
    msg.count.mockResolvedValue(3);
    await beginTurn("u1", "c1", { content: "Next", integrationId: "llm1" });
    expect(conv.update.mock.calls[0][0].data).toEqual({ integrationId: "llm1" });
    owns("My report");
    msg.count.mockResolvedValue(0);
    await beginTurn("u1", "c1", { content: "First", integrationId: "llm1" });
    expect(conv.update.mock.calls[1][0].data).toEqual({ integrationId: "llm1" });
  });

  it("refuses an empty message with 400", async () => {
    owns();
    const err = await rejection(beginTurn("u1", "c1", { content: "   ", integrationId: "llm1" }));
    expect(err.httpStatus).toBe(400);
    expect(msg.create).not.toHaveBeenCalled();
  });

  it("stores screenshots nested in the message, typed by their bytes, in order", async () => {
    owns();
    msg.create.mockResolvedValue({ images: [{ id: "i1", mimeType: "image/png" }, { id: "i2", mimeType: "image/jpeg" }] });
    const out = await beginTurn("u1", "c1", { content: "", images: [PNG, JPEG], integrationId: "llm1" });
    expect(out).toEqual({ question: "", images: [{ id: "i1", mimeType: "image/png" }, { id: "i2", mimeType: "image/jpeg" }] });
    const created = msg.create.mock.calls[0][0].data.images.create;
    expect(created).toHaveLength(2);
    expect(created[0]).toMatchObject({ mimeType: "image/png", sizeBytes: PNG.length, position: 0 });
    expect(created[1]).toMatchObject({ mimeType: "image/jpeg", sizeBytes: JPEG.length, position: 1 });
    expect(created[0].bytes).toBeInstanceOf(Uint8Array);
    expect(conv.update.mock.calls[0][0].data.title).toBe("Screenshots");
  });

  it("titles a single-image turn 'Screenshot'", async () => {
    owns();
    await beginTurn("u1", "c1", { images: [GIF], integrationId: "llm1" });
    expect(conv.update.mock.calls[0][0].data.title).toBe("Screenshot");
  });

  it("refuses a fifth image (400), an oversize one (413) and an unknown type (400)", async () => {
    owns();
    expect((await rejection(beginTurn("u1", "c1", { content: "x", images: [PNG, PNG, PNG, PNG, PNG], integrationId: "l" }))).httpStatus).toBe(400);
    const big = Buffer.concat([PNG, Buffer.alloc(IMAGE_LIMITS.maxBytes)]);
    const e413 = await rejection(beginTurn("u1", "c1", { content: "x", images: [PNG, big], integrationId: "l" }));
    expect(e413.httpStatus).toBe(413);
    expect(e413.message).toMatch(/Image 2/);
    const e400 = await rejection(beginTurn("u1", "c1", { content: "x", images: [Buffer.from("not an image")], integrationId: "l" }));
    expect(e400.httpStatus).toBe(400);
    expect(e400.message).toMatch(/Image 1 is not a PNG, JPEG, WebP or GIF/);
    expect(msg.create).not.toHaveBeenCalled();
  });

  it("accepts exactly 4 images at exactly the size limit", async () => {
    owns();
    const atLimit = Buffer.concat([PNG, Buffer.alloc(IMAGE_LIMITS.maxBytes - PNG.length)]);
    await beginTurn("u1", "c1", { images: [atLimit, PNG, PNG, PNG], integrationId: "l" });
    expect(msg.create.mock.calls[0][0].data.images.create).toHaveLength(4);
  });
});

describe("beginTurn — /retry", () => {
  it("drops the previous answer and returns the last question", async () => {
    owns();
    msg.findMany.mockResolvedValue([
      { id: "m2", role: "assistant", content: "old answer" },
      { id: "m1", role: "user", content: "the question" },
    ]);
    const out = await beginTurn("u1", "c1", { regenerate: true, integrationId: "llm2" });
    expect(out).toEqual({ question: "the question", images: [] });
    expect(msg.delete).toHaveBeenCalledWith({ where: { id: "m2" } });
    expect(conv.update).toHaveBeenCalledWith({ where: { id: "c1" }, data: { integrationId: "llm2" } });
    expect(msg.create).not.toHaveBeenCalled();
  });

  it("deletes nothing when the last message is the unanswered question", async () => {
    owns();
    msg.findMany.mockResolvedValue([{ id: "m1", role: "user", content: "q" }]);
    expect((await beginTurn("u1", "c1", { regenerate: true, integrationId: "l" })).question).toBe("q");
    expect(msg.delete).not.toHaveBeenCalled();
  });

  it("refuses with 400 when there is nothing to retry", async () => {
    owns();
    msg.findMany.mockResolvedValue([]);
    expect((await rejection(beginTurn("u1", "c1", { regenerate: true, integrationId: "l" }))).httpStatus).toBe(400);
  });
});

// ─── finishTurn ───────────────────────────────────────────────────────────

describe("finishTurn", () => {
  it("stores the answer, its advisor lines and each report, then touches the thread", async () => {
    msg.create.mockResolvedValue({ id: "m9" });
    report.create.mockResolvedValueOnce({ id: "r1" }).mockResolvedValueOnce({ id: "r2" });
    const tools = [{ name: "list_assets", label: "Assets", ok: true }];
    const out = await finishTurn("c1", {
      content: "Here.", toolsUsed: tools, stopped: false, preface: "P", signOff: "S",
      reports: [
        { title: "t".repeat(250), columns: [{ key: "a" }], rows: [{ a: 1 }], rowCount: 1, truncated: false } as never,
        { title: "Second", columns: [], rows: [], rowCount: 0, truncated: true, formats: ["csv"] } as never,
      ],
    });
    expect(out).toEqual({ messageId: "m9", reportIds: ["r1", "r2"] });
    expect(msg.create.mock.calls[0][0].data).toEqual({
      conversationId: "c1", role: "assistant", content: "Here.", toolsUsed: tools, stopped: false, preface: "P", signOff: "S",
    });
    expect(report.create.mock.calls[0][0].data).toMatchObject({ messageId: "m9", rowCount: 1, truncated: false, formats: [] });
    expect(report.create.mock.calls[0][0].data.title).toHaveLength(200);
    expect(report.create.mock.calls[1][0].data).toMatchObject({ title: "Second", formats: ["csv"], truncated: true });
    expect(conv.update.mock.calls[0][0].where).toEqual({ id: "c1" });
    expect(conv.update.mock.calls[0][0].data.updatedAt).toBeInstanceOf(Date);
  });

  it("stores a stopped partial answer with null advisor lines", async () => {
    msg.create.mockResolvedValue({ id: "m1" });
    expect(await finishTurn("c1", { content: "par", toolsUsed: [], stopped: true, reports: [] })).toEqual({ messageId: "m1", reportIds: [] });
    expect(msg.create.mock.calls[0][0].data).toMatchObject({ stopped: true, preface: null, signOff: null });
    expect(report.create).not.toHaveBeenCalled();
  });
});

// ─── Prune ────────────────────────────────────────────────────────────────

describe("pruneAssistantConversations", () => {
  it("deletes conversations idle past the retention window in one deleteMany", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-11-14T00:00:00Z"));
      setting.findUnique.mockResolvedValue({ value: { retentionDays: 10 } });
      conv.deleteMany.mockResolvedValue({ count: 3 });
      expect(await pruneAssistantConversations()).toBe(3);
      expect(conv.deleteMany).toHaveBeenCalledTimes(1);
      expect(conv.deleteMany.mock.calls[0][0]).toEqual({ where: { updatedAt: { lt: new Date("2026-11-04T00:00:00Z") } } });
      expect(lg.info).toHaveBeenCalledWith({ count: 3, retentionDays: 10 }, expect.any(String));
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the 90-day default and logs nothing when nothing was pruned", async () => {
    setting.findUnique.mockResolvedValue(null);
    conv.deleteMany.mockResolvedValue({ count: 0 });
    const before = Date.now();
    expect(await pruneAssistantConversations()).toBe(0);
    const cutoff = (conv.deleteMany.mock.calls[0][0].where.updatedAt.lt as Date).getTime();
    expect(before - cutoff).toBeGreaterThanOrEqual(90 * 86_400_000 - 1000);
    expect(before - cutoff).toBeLessThanOrEqual(90 * 86_400_000 + 1000);
    expect(lg.info).not.toHaveBeenCalled();
  });
});
