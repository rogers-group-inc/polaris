/**
 * tests/unit/assistantChatService.test.ts
 *
 * One streamed assistant turn (business rule 94), with the model, the tools
 * and the conversation store mocked:
 *   - text streams through as `token` events, after a `start`;
 *   - a tool round runs each call as the caller and feeds results back;
 *   - the round cap forces a final no-tools answer;
 *   - Stop saves the partial answer with stopped=true;
 *   - a failure before any text saves NOTHING (the question stays for /retry),
 *     and the audit Event never carries the question or answer text.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  chatCompletionRound: vi.fn(),
  runAssistantTool: vi.fn(),
  beginTurn: vi.fn(async () => ({ question: "q" })),
  finishTurn: vi.fn(async () => ({ messageId: "m1", reportIds: [] })),
  recentTurns: vi.fn(async () => [{ role: "user", content: "what is down?" }]),
  logEvent: vi.fn(async () => {}),
}));

vi.mock("../../src/db.js", () => ({ prisma: {} }));
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: h.logEvent }));
vi.mock("../../src/services/llmService.js", async () => ({
  chatCompletionRound: h.chatCompletionRound,
  resolveChatModel: async (_id: string, c: any) => c.model || "picked-default",
  recoverTextToolCalls: (await vi.importActual<typeof import("../../src/services/llmService.js")>("../../src/services/llmService.js")).recoverTextToolCalls,
  LLM_DEFAULTS: { maxToolRounds: 6, maxRowsPerTool: 200, contextMessages: 20 },
}));
vi.mock("../../src/services/assistantToolService.js", () => ({
  assistantToolDefs: () => [{ type: "function", function: { name: "list_assets", description: "", parameters: {} } }],
  runAssistantTool: h.runAssistantTool,
  toolLabel: (n: string) => `did ${n}`,
}));
vi.mock("../../src/services/assistantConversationService.js", () => ({
  beginTurn: h.beginTurn,
  finishTurn: h.finishTurn,
  recentTurns: h.recentTurns,
}));

import { streamAssistantTurn, buildSystemPrompt, stripMarkdownTables, asksForReport, reportTitleFromQuestion, asksHowTo, sanitizeAnswerLinks } from "../../src/services/assistantChatService.js";

const integration = { id: "i1", name: "Ollama", config: { host: "10.0.0.5", model: "qwen", maxToolRounds: 2 } as any };

function run(over: Partial<Parameters<typeof streamAssistantTurn>[0]> = {}) {
  const events: Array<[string, any]> = [];
  const ac = new AbortController();
  const p = streamAssistantTurn({
    req: {} as any,
    userId: "u1",
    username: "dana",
    conversationId: "c1",
    integration,
    content: "what is down?",
    emit: (e, d) => events.push([e, d]),
    signal: ac.signal,
    ...over,
  });
  return { p, events, ac };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("streamAssistantTurn", () => {
  it("streams a plain answer and saves it", async () => {
    h.chatCompletionRound.mockImplementationOnce(async (_c: any, msgs: any[], tools: any[], o: any) => {
      expect(msgs[0].role).toBe("system");
      expect(tools).toHaveLength(1);
      o.onText("Nothing ");
      o.onText("is down.");
      return { content: "Nothing is down.", toolCalls: [], finishReason: "stop" };
    });
    const { p, events } = run();
    await p;
    expect(events.map((e) => e[0])).toEqual(["start", "token", "token", "done"]);
    expect(h.finishTurn).toHaveBeenCalledWith("c1", expect.objectContaining({ content: "Nothing is down.", stopped: false }));
  });

  it("runs a tool round as the caller, then answers", async () => {
    h.chatCompletionRound
      .mockImplementationOnce(async () => ({ content: "", toolCalls: [{ id: "t1", type: "function", function: { name: "list_assets", arguments: '{"monitorStatus":"down"}' } }], finishReason: "tool_calls" }))
      .mockImplementationOnce(async (_c: any, msgs: any[], _t: any, o: any) => {
        const toolMsg = msgs.find((m: any) => m.role === "tool");
        expect(toolMsg).toMatchObject({ tool_call_id: "t1" });
        expect(JSON.parse(toolMsg.content)).toEqual({ total: 2 });
        o.onText("Two are down.");
        return { content: "Two are down.", toolCalls: [], finishReason: "stop" };
      });
    h.runAssistantTool.mockResolvedValueOnce({ ok: true, data: { total: 2 } });
    const req = { session: { userId: "u1" } } as any;
    const { p, events } = run({ req });
    await p;
    expect(h.runAssistantTool).toHaveBeenCalledWith("list_assets", '{"monitorStatus":"down"}', expect.objectContaining({ req }));
    expect(events.filter((e) => e[0] === "tool").map((e) => e[1].status)).toEqual(["running", "done"]);
    expect(h.finishTurn.mock.calls[0][1].toolsUsed).toEqual([{ name: "list_assets", label: "did list_assets", ok: true }]);
  });

  it("runs a tool call the model wrote as text, and withdraws that text from the answer", async () => {
    const written = 'Here is the call:\n```json\n{"name": "list_assets", "arguments": {"monitorStatus": "down"}}\n```';
    h.chatCompletionRound
      .mockImplementationOnce(async (_c: any, _m: any, _t: any, o: any) => {
        o.onText(written);
        return { content: written, toolCalls: [], finishReason: "stop" };
      })
      .mockImplementationOnce(async (_c: any, msgs: any[], _t: any, o: any) => {
        const asst = msgs.find((m: any) => m.role === "assistant");
        expect(asst.content).toBeNull(); // the written call never re-enters the history as text
        expect(asst.tool_calls[0].function).toEqual({ name: "list_assets", arguments: '{"monitorStatus":"down"}' });
        o.onText("Two are down.");
        return { content: "Two are down.", toolCalls: [], finishReason: "stop" };
      });
    h.runAssistantTool.mockResolvedValueOnce({ ok: true, data: { total: 2 } });
    const { p, events } = run();
    await p;
    expect(h.runAssistantTool).toHaveBeenCalledWith("list_assets", '{"monitorStatus":"down"}', expect.anything());
    expect(events.find((e) => e[0] === "retract")).toEqual(["retract", { from: 0 }]);
    expect(h.finishTurn.mock.calls[0][1].content).toBe("Two are down.");
  });

  it("never shows or stores a table the model types after a report (rule 94(c))", async () => {
    const report = { title: "Networks", columns: [{ key: "cidr", label: "CIDR" }], rows: [{ cidr: "10.0.1.0/24" }], rowCount: 1, truncated: false };
    const typed = "Here is the report:\n\n| CIDR | Name |\n|---|---|\n| 192.168.1.0/24 | Lab |\n\nYou can download the full report.";
    h.chatCompletionRound
      .mockImplementationOnce(async () => ({ content: "", toolCalls: [{ id: "r", type: "function", function: { name: "create_report", arguments: "{}" } }], finishReason: "tool_calls" }))
      .mockImplementationOnce(async (_c: any, _m: any, _t: any, o: any) => {
        for (const piece of typed.split(/(?<=\n)/)) o.onText(piece);
        return { content: typed, toolCalls: [], finishReason: "stop" };
      });
    h.runAssistantTool.mockImplementationOnce(async (_n: string, _a: string, ctx: any) => {
      ctx.onReport(report);
      return { ok: true, data: { created: true } };
    });
    const { p, events } = run();
    await p;
    const shown = events.filter((e) => e[0] === "token").map((e) => e[1].text).join("");
    expect(shown).not.toContain("192.168.1.0/24");
    expect(shown).toContain("You can download the full report.");
    const stored = h.finishTurn.mock.calls[0][1];
    expect(stored.content).not.toContain("|");
    expect(stored.reports).toEqual([report]);
  });

  it("says the report is ready when the model wrote nothing but a table", async () => {
    h.chatCompletionRound
      .mockImplementationOnce(async () => ({ content: "", toolCalls: [{ id: "r", type: "function", function: { name: "create_report", arguments: "{}" } }], finishReason: "tool_calls" }))
      .mockImplementationOnce(async (_c: any, _m: any, _t: any, o: any) => {
        o.onText("| A |\n|---|\n| x |");
        return { content: "| A |\n|---|\n| x |", toolCalls: [], finishReason: "stop" };
      });
    h.runAssistantTool.mockImplementationOnce(async (_n: string, _a: string, ctx: any) => {
      ctx.onReport({ title: "T", columns: [], rows: [], rowCount: 0, truncated: false });
      return { ok: true, data: {} };
    });
    await run().p;
    expect(h.finishTurn.mock.calls[0][1].content).toBe("The report is ready — preview and download it below.");
  });

  it("offers only search_help on the first round of a how-to question", async () => {
    h.beginTurn.mockResolvedValueOnce({ question: "how do i add a new ip block?" });
    h.chatCompletionRound.mockImplementationOnce(async (_c: any, _m: any, tools: any[], o: any) => {
      expect(tools.map((t: any) => t.function.name)).toEqual(["search_help"]);
      o.onText("ok");
      return { content: "ok", toolCalls: [], finishReason: "stop" };
    });
    await run({ content: "how do i add a new ip block?" }).p;
  });

  it("unlinks an invented docs URL in the shown and stored answer", async () => {
    const text = "See [the docs](https://docs.polaris.example.com/subnets/add-subnet).";
    h.chatCompletionRound.mockImplementationOnce(async (_c: any, _m: any, _t: any, o: any) => {
      o.onText(text);
      return { content: text, toolCalls: [], finishReason: "stop" };
    });
    const { p, events } = run();
    await p;
    expect(events).toContainEqual(["retract", { from: 0 }]);
    expect(events).toContainEqual(["token", { text: "See the docs." }]);
    expect(h.finishTurn.mock.calls[0][1].content).toBe("See the docs.");
  });

  it("offers only create_report on the first round of a report request", async () => {
    h.chatCompletionRound.mockImplementationOnce(async (_c: any, _m: any, tools: any[], o: any) => {
      expect(tools.map((t: any) => t.function.name)).toEqual(["create_report"]);
      o.onText("ok");
      return { content: "ok", toolCalls: [], finishReason: "stop" };
    });
    await run({ content: "give me a report on the network utilizations" }).p;
  });

  it("builds the report from the model's list lookup when it never called create_report", async () => {
    h.beginTurn.mockResolvedValueOnce({ question: "give me a report on the network utilizations" });
    h.chatCompletionRound
      .mockImplementationOnce(async () => ({ content: "", toolCalls: [{ id: "s", type: "function", function: { name: "list_networks", arguments: '{"minUtilizationPercent":50}' } }], finishReason: "tool_calls" }))
      .mockImplementationOnce(async (_c: any, _m: any, _t: any, o: any) => {
        o.onText("No network is over 50%.");
        return { content: "No network is over 50%.", toolCalls: [], finishReason: "stop" };
      });
    h.runAssistantTool.mockResolvedValue({ ok: true, data: {} });
    await run({ content: "give me a report on the network utilizations" }).p;
    const last = h.runAssistantTool.mock.calls.at(-1)!;
    expect(last[0]).toBe("create_report");
    expect(JSON.parse(last[1])).toEqual({ title: "Network utilizations", source: "list_networks", args: { minUtilizationPercent: 50 } });
  });

  it("offers no tools on the last round so the model must answer", async () => {
    const toolCall = { content: "", toolCalls: [{ id: "x", type: "function", function: { name: "list_assets", arguments: "{}" } }], finishReason: "tool_calls" };
    h.chatCompletionRound
      .mockResolvedValueOnce(toolCall)
      .mockResolvedValueOnce(toolCall)
      .mockImplementationOnce(async (_c: any, _m: any, tools: any[], o: any) => {
        expect(tools).toEqual([]);
        o.onText("Done.");
        return { content: "Done.", toolCalls: [], finishReason: "stop" };
      });
    h.runAssistantTool.mockResolvedValue({ ok: true, data: {} });
    await run().p;
    expect(h.chatCompletionRound).toHaveBeenCalledTimes(3);
  });

  it("saves a partial answer as stopped when the client hangs up", async () => {
    let ctl: AbortController;
    h.chatCompletionRound.mockImplementationOnce(async (_c: any, _m: any, _t: any, o: any) => {
      o.onText("Half an ans");
      ctl.abort();
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });
    const r = run();
    ctl = r.ac;
    await r.p;
    expect(h.finishTurn).toHaveBeenCalledWith("c1", expect.objectContaining({ content: "Half an ans", stopped: true }));
    expect(r.events.at(-1)).toEqual(["done", { messageId: "m1", stopped: true }]);
  });

  it("saves nothing when the model fails before any text, and never logs the question", async () => {
    h.chatCompletionRound.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
    const { p, events } = run();
    await p;
    expect(h.finishTurn).not.toHaveBeenCalled();
    expect(events.at(-1)?.[0]).toBe("error");
    const ev = h.logEvent.mock.calls[0][0] as any;
    expect(ev.action).toBe("assistant.chat");
    expect(JSON.stringify(ev)).not.toContain("what is down?");
  });

  it("refuses an integration with no host before touching the conversation", async () => {
    await expect(run({ integration: { ...integration, config: { host: "", model: "" } } }).p).rejects.toThrow(/has no host/);
    expect(h.beginTurn).not.toHaveBeenCalled();
  });

  it("sends the server's default pick when Model is blank", async () => {
    h.chatCompletionRound.mockImplementationOnce(async (c: any, _m: any, _t: any, o: any) => {
      expect(c.model).toBe("picked-default");
      o.onText("ok");
      return { content: "ok", toolCalls: [], finishReason: "stop" };
    });
    await run({ integration: { ...integration, config: { host: "h", model: "" } } }).p;
    expect(h.chatCompletionRound).toHaveBeenCalledTimes(1);
  });
});

describe("report intent", () => {
  it("recognizes a request for a report, and not a help question about one", () => {
    expect(asksForReport("give me a report on the network utilizations")).toBe(true);
    expect(asksForReport("Create a downloadable report: switches down")).toBe(true);
    expect(asksForReport("export every firewall to csv")).toBe(true);
    expect(asksForReport("how do I export a report?")).toBe(false);
    expect(asksForReport("what's down right now?")).toBe(false);
  });

  it("titles a report from the question", () => {
    expect(reportTitleFromQuestion("give me a report on the network utilizations")).toBe("Network utilizations");
    expect(reportTitleFromQuestion("Create a downloadable report: switches down in the last 24h")).toBe("Switches down in the last 24h");
    expect(reportTitleFromQuestion("report")).toBe("Report");
  });
});

describe("help questions and links", () => {
  it("recognizes how-to questions but not data questions", () => {
    expect(asksHowTo("how do i add a new ip block?")).toBe(true);
    expect(asksHowTo("Where can I change the theme?")).toBe(true);
    expect(asksHowTo("Using the Polaris help documentation, answer: maintenance windows")).toBe(true);
    expect(asksHowTo("how many cities do we have devices in?")).toBe(false);
    expect(asksHowTo("what's down right now?")).toBe(false);
  });

  it("keeps real help pages and in-app paths, and unlinks everything else", () => {
    const pages = new Set(["IPAM", "Integrations"]);
    const wiki = "https://github.com/rogers-group-inc/polaris/wiki";
    const t = [
      `See [IPAM — IP Blocks](${wiki}/IPAM#ip-blocks).`,
      `Or [Adding a New Subnet](https://docs.polaris.example.com/subnets/add-subnet).`,
      `Also [Made up](${wiki}/Subnets).`,
      `Open [IPAM](/ipam.html).`,
      `Bare: https://docs.polaris.example.com/x and ${wiki}/Integrations`,
    ].join("\n");
    const out = sanitizeAnswerLinks(t, pages);
    expect(out).toContain(`[IPAM — IP Blocks](${wiki}/IPAM#ip-blocks)`);
    expect(out).toContain("Or Adding a New Subnet.");
    expect(out).toContain("Also Made up.");
    expect(out).toContain("[IPAM](/ipam.html)");
    expect(out).not.toContain("example.com");
    expect(out).toContain(`${wiki}/Integrations`);
  });
});

describe("stripMarkdownTables", () => {
  it("removes pipe tables and keeps the prose around them", () => {
    const t = "Intro.\n\n| a | b |\n| --- | :---: |\n| 1 | 2 |\n| 3 | 4 |\n\nOutro.";
    expect(stripMarkdownTables(t)).toBe("Intro.\n\nOutro.");
  });
  it("leaves text without a separator row alone", () => {
    expect(stripMarkdownTables("use a | b here")).toBe("use a | b here");
  });
});

describe("buildSystemPrompt", () => {
  it("states the ground rules and appends operator instructions", () => {
    const p = buildSystemPrompt({ username: "dana", now: new Date("2026-10-07T12:00:00Z"), extra: "Sites are named NSH-*." });
    expect(p).toContain("2026-10-07T12:00:00.000Z");
    expect(p).toContain("dana");
    expect(p).toMatch(/search_help/);
    expect(p).toMatch(/create_report/);
    expect(p).toMatch(/Never invent/);
    expect(p).toMatch(/Operator instructions:\nSites are named NSH-\*\./);
  });

  it("tells the model the name the operator gave it, and stays nameless otherwise", () => {
    expect(buildSystemPrompt({ displayName: "NOC Bot" })).toMatch(/^Your name is NOC Bot\. You are the Polaris assistant/);
    expect(buildSystemPrompt({ displayName: "  " })).toMatch(/^You are the Polaris assistant/);
  });
});
