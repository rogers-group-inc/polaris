/**
 * tests/unit/assistantChatService.test.ts
 *
 * One streamed assistant turn (business rule 95), with the model, the tools
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
  estimateTokens: (t: string) => Math.ceil((t ?? "").length / 3.5),
  LLM_DEFAULTS: { maxToolRounds: 6, maxRowsPerTool: 200, contextMessages: 20, contextWindow: 8192 },
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

import {
  streamAssistantTurn, buildSystemPrompt, stripMarkdownTables, asksForReport, reportTitleFromQuestion, asksHowTo, sanitizeAnswerLinks,
  contextBudget, fitHistory, compactToolResults,
} from "../../src/services/assistantChatService.js";

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

  it("never shows or stores a table the model types after a report (rule 95(c))", async () => {
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

  it("reports a thinking model's reasoning as a running length, summed across rounds and throttled", async () => {
    h.chatCompletionRound
      .mockImplementationOnce(async (_c: any, _m: any, _t: any, o: any) => {
        o.onReasoning(100);
        o.onReasoning(200); // inside the 400 ms throttle — not emitted
        return { content: "", toolCalls: [{ id: "t", type: "function", function: { name: "list_assets", arguments: "{}" } }], finishReason: "tool_calls" };
      })
      .mockImplementationOnce(async (_c: any, _m: any, _t: any, o: any) => {
        await new Promise((r) => setTimeout(r, 420));
        o.onReasoning(50);
        o.onText("ok");
        return { content: "ok", toolCalls: [], finishReason: "stop" };
      });
    h.runAssistantTool.mockResolvedValueOnce({ ok: true, data: {} });
    const { p, events } = run();
    await p;
    expect(events.filter((e) => e[0] === "thinking").map((e) => e[1].chars)).toEqual([100, 250]);
    // Reasoning is never part of the answer.
    expect(h.finishTurn.mock.calls[0][1].content).toBe("ok");
  });

  it("clips a lookup result to the context window's share", async () => {
    const big = { rows: "x".repeat(20_000) };
    h.chatCompletionRound
      .mockImplementationOnce(async () => ({ content: "", toolCalls: [{ id: "t", type: "function", function: { name: "list_assets", arguments: "{}" } }], finishReason: "tool_calls" }))
      .mockImplementationOnce(async (_c: any, msgs: any[], _t: any, o: any) => {
        const toolMsg = msgs.find((m: any) => m.role === "tool");
        // 4096 tokens × 3.5 chars × 25 % = 3584 chars, plus the truncation note.
        expect(toolMsg.content.length).toBeLessThan(3700);
        expect(toolMsg.content).toContain("truncated");
        o.onText("ok");
        return { content: "ok", toolCalls: [], finishReason: "stop" };
      });
    h.runAssistantTool.mockResolvedValueOnce({ ok: true, data: big });
    await run({ integration: { ...integration, config: { ...integration.config, contextWindow: 4096 } } }).p;
  });

  it("drops the oldest history that will not fit the window, keeping the question", async () => {
    const long = "y".repeat(6000);
    h.recentTurns.mockResolvedValueOnce([
      { role: "user", content: "old question " + long },
      { role: "assistant", content: "old answer " + long },
      { role: "user", content: "what is down?" },
    ] as any);
    h.chatCompletionRound.mockImplementationOnce(async (_c: any, msgs: any[], _t: any, o: any) => {
      expect(msgs.map((m: any) => m.role)).toEqual(["system", "user"]);
      expect(msgs[1].content).toBe("what is down?");
      o.onText("ok");
      return { content: "ok", toolCalls: [], finishReason: "stop" };
    });
    await run({ integration: { ...integration, config: { ...integration.config, contextWindow: 4096 } } }).p;
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

describe("context budget", () => {
  it("sizes the prompt and lookup results to the window, within bounds", () => {
    expect(contextBudget(8192)).toEqual({ window: 8192, promptTokens: 4915, toolResultChars: 7168 });
    expect(contextBudget(undefined).window).toBe(8192);
    expect(contextBudget(512).window).toBe(2048); // floor
    expect(contextBudget(2048).toolResultChars).toBe(1792);
    expect(contextBudget(131_072).toolResultChars).toBe(24_000); // ceiling
  });

  it("keeps the newest turns that fit and never opens on an orphaned answer", () => {
    const turns = [
      { role: "user" as const, content: "a".repeat(350) },      // ~100 tokens
      { role: "assistant" as const, content: "b".repeat(350) },
      { role: "user" as const, content: "c".repeat(350) },
    ];
    expect(fitHistory(0, turns, 1000)).toHaveLength(3);
    // Room for two: the answer would lead, so it is dropped too.
    expect(fitHistory(0, turns, 220).map((t) => t.content[0])).toEqual(["c"]);
    expect(fitHistory(0, [], 100)).toEqual([]);
  });

  it("cuts the question itself down when nothing else fits", () => {
    const out = fitHistory(10_000, [{ role: "user", content: "q".repeat(5000) }], 4000);
    expect(out).toHaveLength(1);
    expect(out[0].content.length).toBeLessThan(5000);
    expect(out[0].content.endsWith("…")).toBe(true);
  });

  it("replaces the oldest lookup results first, and never the newest", () => {
    const msgs: any[] = [
      { role: "system", content: "s" },
      { role: "tool", tool_call_id: "1", content: "x".repeat(3500) },
      { role: "tool", tool_call_id: "2", content: "y".repeat(3500) },
      { role: "tool", tool_call_id: "3", content: "z".repeat(3500) },
    ];
    expect(compactToolResults(msgs, 1500)).toBe(2);
    expect(msgs[1].content).toContain("omitted");
    expect(msgs[2].content).toContain("omitted");
    expect(msgs[3].content[0]).toBe("z");
    expect(compactToolResults(msgs, 100_000)).toBe(0);
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
