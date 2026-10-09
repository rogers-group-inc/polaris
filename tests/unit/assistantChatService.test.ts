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
 *     and the audit Event never carries the question or answer text;
 *   - memory (rule 95(i)): off → no block, no remember/forget tools; on → the
 *     block rides the system prompt, the tools are offered, and a memory call
 *     goes to runMemoryTool (grounded in THIS turn's question), never to the
 *     read-only lookup runner.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  chatCompletionRound: vi.fn(),
  runAssistantTool: vi.fn(),
  beginTurn: vi.fn(async () => ({ question: "q" })),
  finishTurn: vi.fn(async () => ({ messageId: "m1", reportIds: [] })),
  recentTurns: vi.fn(async () => [{ role: "user", content: "what is down?" }]),
  getEfficiencyAdvisor: vi.fn(async () => false),
  recentAdvisorLines: vi.fn(async () => ({ prefaces: [] as string[], signOffs: [] as string[] })),
  logEvent: vi.fn(async () => {}),
  getMemoryEnabled: vi.fn(async () => false),
  listMemory: vi.fn(async () => [] as any[]),
  runMemoryTool: vi.fn(),
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
  // The real tool NAMES (the round-0 steering filters by name); the shapes do not matter here.
  assistantToolDefs: () => ["search_help", "search", "fleet_summary", "list_assets", "get_asset", "list_alerts", "list_events", "list_networks", "list_reservations", "create_report"]
    .map((name) => ({ type: "function", function: { name, description: "", parameters: {} } })),
  runAssistantTool: h.runAssistantTool,
  toolLabel: (n: string) => `did ${n}`,
}));
vi.mock("../../src/services/assistantMemoryService.js", async () => {
  const real = await vi.importActual<typeof import("../../src/services/assistantMemoryService.js")>("../../src/services/assistantMemoryService.js");
  return {
    getMemoryEnabled: h.getMemoryEnabled,
    listMemory: h.listMemory,
    runMemoryTool: h.runMemoryTool,
    memoryPromptBlock: real.memoryPromptBlock,
    memoryToolDefs: real.memoryToolDefs,
    memoryToolLabel: real.memoryToolLabel,
    MEMORY_TOOL_NAMES: real.MEMORY_TOOL_NAMES,
  };
});
vi.mock("../../src/services/assistantConversationService.js", () => ({
  beginTurn: h.beginTurn,
  finishTurn: h.finishTurn,
  recentTurns: h.recentTurns,
  getEfficiencyAdvisor: h.getEfficiencyAdvisor,
  recentAdvisorLines: h.recentAdvisorLines,
}));

import { SIGN_OFFS, LOOKUP_LINES, ADVISOR_PERSONA, advisorVoice, _setAdvisorPlacementRand } from "../../src/services/efficiencyAdvisorService.js";
import {
  streamAssistantTurn, buildSystemPrompt, stripMarkdownTables, asksForReport, reportTitleFromQuestion, asksHowTo, sanitizeAnswerLinks,
  contextBudget, fitHistory, compactToolResults, permissionsPromptBlock, scopePromptBlock,
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

describe("streamAssistantTurn — memory (rule 95(i))", () => {
  it("sends no memory block and no memory tools while memory is off", async () => {
    h.chatCompletionRound.mockImplementationOnce(async (_c: any, msgs: any[], tools: any[]) => {
      expect(msgs[0].content).not.toContain("Memory —");
      expect(tools.map((t: any) => t.function.name)).toEqual(["list_assets"]);
      return { content: "ok", toolCalls: [], finishReason: "stop" };
    });
    await run().p;
    expect(h.listMemory).not.toHaveBeenCalled();
  });

  it("puts the entries in the system prompt and offers remember/forget while on", async () => {
    h.getMemoryEnabled.mockResolvedValueOnce(true);
    h.listMemory.mockResolvedValueOnce([{ id: "e1", text: "Manages Nashville", source: "user", createdAt: new Date() }]);
    h.chatCompletionRound.mockImplementationOnce(async (_c: any, msgs: any[], tools: any[]) => {
      expect(msgs[0].content).toContain("[1] Manages Nashville");
      expect(tools.map((t: any) => t.function.name)).toEqual(["list_assets", "remember", "forget"]);
      return { content: "ok", toolCalls: [], finishReason: "stop" };
    });
    await run().p;
  });

  it("routes a remember call to the memory runner with this turn's question, and emits the change", async () => {
    h.getMemoryEnabled.mockResolvedValueOnce(true);
    h.beginTurn.mockResolvedValueOnce({ question: "remember I manage Nashville" });
    h.runMemoryTool.mockImplementationOnce(async (_n: string, _a: string, turn: any) => {
      turn.onChange({ action: "remembered", text: "Manages Nashville" });
      return { ok: true, data: { remembered: "Manages Nashville" } };
    });
    h.chatCompletionRound
      .mockImplementationOnce(async () => ({ content: "", toolCalls: [{ id: "t1", type: "function", function: { name: "remember", arguments: '{"fact":"Manages Nashville"}' } }], finishReason: "tool_calls" }))
      .mockImplementationOnce(async (_c: any, _m: any, _t: any, o: any) => {
        o.onText("Noted.");
        return { content: "Noted.", toolCalls: [], finishReason: "stop" };
      });
    const { p, events } = run({ content: "remember I manage Nashville" });
    await p;
    expect(h.runAssistantTool).not.toHaveBeenCalled();
    expect(h.runMemoryTool).toHaveBeenCalledWith("remember", '{"fact":"Manages Nashville"}', expect.objectContaining({ question: "remember I manage Nashville", userId: "u1" }));
    expect(events.find((e) => e[0] === "memory")).toEqual(["memory", { action: "remembered", text: "Manages Nashville" }]);
    expect(h.finishTurn.mock.calls[0][1].toolsUsed).toEqual([{ name: "remember", label: "updated memory", ok: true }]);
  });

  it("does not run a memory tool the model calls while memory is off", async () => {
    h.chatCompletionRound
      .mockImplementationOnce(async () => ({ content: "", toolCalls: [{ id: "t1", type: "function", function: { name: "remember", arguments: '{"fact":"x"}' } }], finishReason: "tool_calls" }))
      .mockImplementationOnce(async () => ({ content: "ok", toolCalls: [], finishReason: "stop" }));
    h.runAssistantTool.mockResolvedValueOnce({ ok: false, data: { error: "Unknown tool remember" } });
    await run().p;
    expect(h.runMemoryTool).not.toHaveBeenCalled();
  });
});

describe("streamAssistantTurn", () => {
  it("streams a plain answer and saves it", async () => {
    h.chatCompletionRound.mockImplementationOnce(async (_c: any, msgs: any[], tools: any[], o: any) => {
      expect(msgs[0].role).toBe("system");
      expect(tools.length).toBeGreaterThan(1); // every tool: "what is down?" matches no playbook
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

describe("playbooks steer round 0", () => {
  it("a correlation question gets the playbook's tools on round 0 and its procedure as a second system message", async () => {
    h.beginTurn.mockResolvedValueOnce({ question: "why did NSH-FW01 go down last night?" });
    let round0Tools: string[] = [];
    let round0Msgs: any[] = [];
    h.chatCompletionRound.mockImplementationOnce(async (_c: any, msgs: any[], tools: any[], o: any) => {
      round0Tools = tools.map((t) => t.function.name);
      round0Msgs = [...msgs];
      o.onText("Checking.");
      return { content: "Checking.", toolCalls: [], finishReason: "stop" };
    });
    await run().p;
    expect(round0Tools.sort()).toEqual(["get_asset", "list_alerts", "search"]);
    expect(round0Msgs[0].role).toBe("system");
    expect(round0Msgs[1]).toMatchObject({ role: "system" });
    expect(round0Msgs[1].content).toMatch(/^Playbook — outage correlation/);
    expect(h.logEvent).toHaveBeenCalledWith(expect.objectContaining({ details: expect.objectContaining({ playbook: "correlate" }) }));
  });

  it("every tool is back from round 1", async () => {
    h.beginTurn.mockResolvedValueOnce({ question: "what changed overnight?" });
    let round1Tools: string[] = [];
    h.chatCompletionRound
      .mockImplementationOnce(async () => ({ content: "", toolCalls: [{ id: "t1", type: "function", function: { name: "list_events", arguments: "{}" } }], finishReason: "tool_calls" }))
      .mockImplementationOnce(async (_c: any, _m: any, tools: any[], o: any) => { round1Tools = tools.map((t) => t.function.name); o.onText("Two things."); return { content: "Two things.", toolCalls: [], finishReason: "stop" }; });
    h.runAssistantTool.mockResolvedValueOnce({ ok: true, data: { total: 2, rows: [] } });
    await run().p;
    expect(round1Tools).toContain("create_report");
    expect(round1Tools).toContain("search_help");
  });

  it("a report request and a how-to keep priority over a playbook", async () => {
    for (const [question, only] of [["give me a report on what changed overnight", "create_report"], ["how do I check the health of a device?", "search_help"]] as const) {
      h.beginTurn.mockResolvedValueOnce({ question });
      let round0Tools: string[] = [];
      h.chatCompletionRound.mockImplementationOnce(async (_c: any, msgs: any[], tools: any[], o: any) => {
        round0Tools = tools.map((t) => t.function.name);
        expect(msgs.filter((m) => m.role === "system")).toHaveLength(1);
        o.onText("Done.");
        return { content: "Done.", toolCalls: [], finishReason: "stop" };
      });
      await run().p;
      expect(round0Tools).toEqual([only]);
    }
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
    // Seen live 2026-10-09: a how-to for adding an asset neither checked for the asset nor said how to.
    expect(p).toMatch(/how-to is about ADDING something[\s\S]*look it up[\s\S]*BEFORE answering/);
    expect(p).toMatch(/offer to do the search for them/);
    expect(p).toMatch(/Never imply someone is about to create a duplicate/);
    expect(p).toMatch(/Operator instructions:\nSites are named NSH-\*\./);
  });

  it("tells the model the name the operator gave it, and stays nameless otherwise", () => {
    expect(buildSystemPrompt({ displayName: "NOC Bot" })).toMatch(/^Your name is NOC Bot\. You are the Polaris assistant/);
    expect(buildSystemPrompt({ displayName: "  " })).toMatch(/^You are the Polaris assistant/);
  });
});

describe("streamAssistantTurn — Efficiency Advisor (rule 95(h))", () => {
  const answerWith = (text: string) => async (_c: any, msgs: any[], _t: any, o: any) => {
    // The model never sees the advisor: no persona in its prompt.
    expect(msgs[0].content).not.toMatch(/efficien/i);
    o.onText(text);
    return { content: text, toolCalls: [], finishReason: "stop" };
  };
  const lookupThen = (data: unknown, text: string) => {
    h.chatCompletionRound
      .mockImplementationOnce(async () => ({ content: "", toolCalls: [{ id: "t1", type: "function", function: { name: "list_networks", arguments: "{}" } }], finishReason: "tool_calls" }))
      .mockImplementationOnce(answerWith(text));
    h.runAssistantTool.mockResolvedValueOnce({ ok: true, data });
  };

  // One canned line per turn, leading or closing on a coin flip: pin the coin
  // to CLOSE here, and to LEAD in the tests about the before-lookup line.
  beforeEach(() => _setAdvisorPlacementRand(() => 0.9));

  it("adds nothing when the user has it off", async () => {
    h.chatCompletionRound.mockImplementationOnce(answerWith("Hello."));
    const { p, events } = run({ content: "hi" });
    await p;
    expect(events.some((e) => e[0] === "signoff")).toBe(false);
    expect(h.finishTurn.mock.calls[0][1].signOff).toBeNull();
  });

  it("congratulates after a lookup that found something, stores the line apart from the answer", async () => {
    h.getEfficiencyAdvisor.mockResolvedValueOnce(true);
    h.beginTurn.mockResolvedValueOnce({ question: "how many networks do we have?" });
    lookupThen({ total: 42, rows: [] }, "You have 42 networks.");
    const { p, events } = run();
    await p;
    const line = events.find((e) => e[0] === "signoff")?.[1].text;
    expect(SIGN_OFFS.congratulation.map((t) => t.replace("{topic}", "networks"))).toContain(line);
    const saved = h.finishTurn.mock.calls[0][1];
    expect(saved.content).toBe("You have 42 networks.");
    expect(saved.signOff).toBe(line);
  });

  it("shows a before-lookup line as the first lookup starts, before the tool chip, and stores it — and then no sign-off", async () => {
    _setAdvisorPlacementRand(() => 0.1);
    h.getEfficiencyAdvisor.mockResolvedValueOnce(true);
    h.beginTurn.mockResolvedValueOnce({ question: "how many networks do we have?" });
    lookupThen({ total: 42, rows: [] }, "You have 42 networks.");
    const { p, events } = run();
    await p;
    const names = events.map((e) => e[0]);
    expect(names.indexOf("preface")).toBeLessThan(names.indexOf("tool"));
    const line = events.find((e) => e[0] === "preface")?.[1].text;
    expect(LOOKUP_LINES).toContain(line);
    expect(events.some((e) => e[0] === "signoff")).toBe(false);
    expect(h.finishTurn.mock.calls[0][1]).toMatchObject({ preface: line, signOff: null });
  });

  it("a turn with no lookup closes even when the coin said lead — the only place a line can go", async () => {
    _setAdvisorPlacementRand(() => 0.1);
    h.getEfficiencyAdvisor.mockResolvedValueOnce(true);
    h.beginTurn.mockResolvedValueOnce({ question: "thanks!" });
    h.chatCompletionRound.mockImplementationOnce(answerWith("You're welcome."));
    const { p, events } = run();
    await p;
    expect(events.some((e) => e[0] === "preface")).toBe(false);
    expect(SIGN_OFFS.funDetected).toContain(events.find((e) => e[0] === "signoff")?.[1].text);
  });

  it("no before-lookup line on a turn with no lookup", async () => {
    h.getEfficiencyAdvisor.mockResolvedValueOnce(true);
    h.chatCompletionRound.mockImplementationOnce(answerWith("Hello."));
    const { p, events } = run({ content: "hi" });
    await p;
    expect(events.some((e) => e[0] === "preface")).toBe(false);
    expect(h.finishTurn.mock.calls[0][1].preface).toBeNull();
  });

  it("on an outage the before-lookup line leads when the coin says so (owner's call)", async () => {
    _setAdvisorPlacementRand(() => 0.1);
    h.getEfficiencyAdvisor.mockResolvedValueOnce(true);
    h.beginTurn.mockResolvedValueOnce({ question: "anything alerting?" });
    lookupThen({ total: 1, rows: [{ severity: "critical", assetHostname: "NSH-FW01" }] }, "NSH-FW01 has a critical alert.");
    const { p, events } = run();
    await p;
    const prefaces = events.filter((e) => e[0] === "preface").map((e) => e[1].text);
    expect(prefaces).toHaveLength(1);
    expect(LOOKUP_LINES).toContain(prefaces[0]);
    expect(events.some((e) => e[0] === "signoff")).toBe(false);
    expect(h.finishTurn.mock.calls[0][1]).toMatchObject({ preface: prefaces[0], signOff: null });
  });

  it("an outage question closes with a let-down line when the coin says close", async () => {
    h.getEfficiencyAdvisor.mockResolvedValueOnce(true);
    h.beginTurn.mockResolvedValueOnce({ question: "why is NSH-FW01 down?" });
    lookupThen({ total: 0, rows: [] }, "No such device.");
    const { p, events } = run();
    await p;
    expect(events.some((e) => e[0] === "preface")).toBe(false);
    expect(SIGN_OFFS.letDown).toContain(events.find((e) => e[0] === "signoff")?.[1].text);
  });

  it("does not repeat this conversation's recent lines while others are left", async () => {
    h.getEfficiencyAdvisor.mockResolvedValueOnce(true);
    h.beginTurn.mockResolvedValueOnce({ question: "thanks!" });
    const [keep, ...used] = SIGN_OFFS.funDetected;
    h.recentAdvisorLines.mockResolvedValueOnce({ prefaces: [], signOffs: used });
    h.chatCompletionRound.mockImplementationOnce(answerWith("You're welcome."));
    const { p, events } = run();
    await p;
    expect(events.find((e) => e[0] === "signoff")?.[1].text).toBe(keep);
  });
});

describe("streamAssistantTurn — Efficiency Advisor voice on Azure AI Foundry (rule 95(k))", () => {
  const azure = { id: "i2", name: "Foundry", config: { provider: "azure", host: "res.openai.azure.com", model: "gpt-4o", maxToolRounds: 2 } as any };
  const say = (text: string) => async (_c: any, _m: any, _t: any, o: any) => {
    o.onText(text);
    return { content: text, toolCalls: [], finishReason: "stop" };
  };

  it("puts the persona in the model's prompt and shows no canned line", async () => {
    h.getEfficiencyAdvisor.mockResolvedValueOnce(true);
    h.beginTurn.mockResolvedValueOnce({ question: "thanks!" });
    let prompt = "";
    h.chatCompletionRound.mockImplementationOnce(async (c: any, m: any[], t: any, o: any) => { prompt = m[0].content; return say("Gratitude logged.")(c, m, t, o); });
    const { p, events } = run({ integration: azure });
    await p;
    expect(prompt).toContain(ADVISOR_PERSONA);
    expect(h.recentAdvisorLines).not.toHaveBeenCalled();
    expect(events.some((e) => e[0] === "preface" || e[0] === "signoff")).toBe(false);
    expect(h.finishTurn.mock.calls[0][1]).toMatchObject({ content: "Gratitude logged.", preface: null, signOff: null });
  });

  it("no persona for a user who has not ticked the advisor", async () => {
    h.beginTurn.mockResolvedValueOnce({ question: "thanks!" });
    let prompt = "";
    h.chatCompletionRound.mockImplementationOnce(async (c: any, m: any[], t: any, o: any) => { prompt = m[0].content; return say("You're welcome.")(c, m, t, o); });
    await run({ integration: azure }).p;
    expect(prompt).not.toMatch(/efficien/i);
  });

  it("keeps the persona on a question about an outage (owner's call) — its outage rule does the restraint", async () => {
    h.getEfficiencyAdvisor.mockResolvedValueOnce(true);
    h.beginTurn.mockResolvedValueOnce({ question: "why is NSH-FW01 down?" });
    let prompt = "";
    h.chatCompletionRound.mockImplementationOnce(async (c: any, m: any[], t: any, o: any) => { prompt = m[0].content; return say("Checking.")(c, m, t, o); });
    await run({ integration: azure }).p;
    expect(prompt).toContain(ADVISOR_PERSONA);
    expect(ADVISOR_PERSONA).toMatch(/NEVER joke about the devices, the outage itself or its impact/);
    expect(ADVISOR_PERSONA).toMatch(/company has been let down/);
  });

  it("adds no mid-turn note when a lookup shows something critical — the character carries on", async () => {
    h.getEfficiencyAdvisor.mockResolvedValueOnce(true);
    h.beginTurn.mockResolvedValueOnce({ question: "anything alerting?" });
    let second: any[] = [];
    h.chatCompletionRound
      .mockImplementationOnce(async () => ({ content: "", toolCalls: [{ id: "t1", type: "function", function: { name: "list_alerts", arguments: "{}" } }], finishReason: "tool_calls" }))
      .mockImplementationOnce(async (c: any, m: any[], t: any, o: any) => { second = [...m]; return say("NSH-FW01 has a critical alert.")(c, m, t, o); });
    h.runAssistantTool.mockResolvedValueOnce({ ok: true, data: { total: 1, rows: [{ severity: "critical", assetHostname: "NSH-FW01" }] } });
    await run({ integration: azure }).p;
    expect(second.filter((m) => m.role === "system")).toHaveLength(1);
    expect(second[0].content).toContain(ADVISOR_PERSONA);
  });

  it("carries a round's raw provider blocks onto the next round's assistant turn (Claude thinking replay)", async () => {
    h.beginTurn.mockResolvedValueOnce({ question: "how many networks?" });
    const raw = [{ type: "thinking", thinking: "", signature: "s" }, { type: "tool_use", id: "t1", name: "list_networks", input: {} }];
    let second: any[] = [];
    h.chatCompletionRound
      .mockImplementationOnce(async () => ({ content: "", toolCalls: [{ id: "t1", type: "function", function: { name: "list_networks", arguments: "{}" } }], finishReason: "tool_calls", raw }))
      .mockImplementationOnce(async (c: any, m: any[], t: any, o: any) => { second = [...m]; return say("42.")(c, m, t, o); });
    h.runAssistantTool.mockResolvedValueOnce({ ok: true, data: { total: 42, rows: [] } });
    await run({ integration: azure }).p;
    expect(second.find((m) => m.role === "assistant")?.raw).toBe(raw);
  });

  it("picks the voice from the toggle and the provider", () => {
    expect(advisorVoice(true, undefined)).toBe("canned");
    expect(advisorVoice(true, "openai")).toBe("canned");
    expect(advisorVoice(true, "azure")).toBe("model");
    expect(advisorVoice(false, "azure")).toBe("off");
  });
});

describe("permissionsPromptBlock — the model knows what the person may do", () => {
  it("names the role and every granted area, calls subnets Networks, and says plainly rather than hedging", () => {
    const b = permissionsPromptBlock({ name: "NOC Operator", permissions: { subnets: "write", assets: "read", users: "none" } })!;
    expect(b).toContain('role is "NOC Operator"');
    expect(b).toContain("Networks: Read-Write");
    expect(b).toContain("Assets: Read");
    expect(b).not.toMatch(/Subnets:|Users:/);
    expect(b).toMatch(/do not hedge/);
  });

  it("marks an administrator role, and is absent without a role", () => {
    expect(permissionsPromptBlock({ name: "Admin", permissions: { users: "fullwrite", roles: "fullwrite" } })).toMatch(/an administrator role/);
    expect(permissionsPromptBlock(null)).toBeNull();
  });

  it("rides the system prompt when given", () => {
    expect(buildSystemPrompt({ access: "ACCESS-BLOCK" })).toContain("ACCESS-BLOCK");
  });
});

describe("ADVISOR_PERSONA — R.A.L.P.H. lines the owner wrote", () => {
  it("carries the exact explanation and off-switch lines, and never offers to drop the act", () => {
    expect(ADVISOR_PERSONA).toContain("I'm running in that mode because you feel you need all the help you can get.");
    expect(ADVISOR_PERSONA).toContain("If you don't want your performance to be scrutinized and logged then de-select R.A.L.P.H. at the top.");
    expect(ADVISOR_PERSONA).toMatch(/Never offer to drop the act/);
    expect(ADVISOR_PERSONA).toMatch(/WHOLE answer/);
    expect(ADVISOR_PERSONA).toMatch(/never invents a fact about their situation/);
    expect(ADVISOR_PERSONA).toContain("If your fingers lack the dexterity to search for it yourself, I would be happy to perform a more accurate search for you.");
  });
});

describe("scopePromptBlock — \"my region\" means something", () => {
  it("names the person's regions and tags and points at list_assets myRegions", () => {
    const b = scopePromptBlock({ regions: ["Middle Tennessee", "Alabama"], tags: ["nashville-noc"] })!;
    expect(b).toContain("The person's regions: Middle Tennessee, Alabama.");
    expect(b).toMatch(/myRegions: true/);
    expect(b).toContain("Their other scope tags: nashville-noc.");
  });

  it("says to ask when no region is assigned, and is absent without a scope", () => {
    expect(scopePromptBlock({ regions: [], tags: [] })).toMatch(/No region is assigned/);
    expect(scopePromptBlock(null)).toBeNull();
  });
});

describe("asset links in an answer", () => {
  const pages = new Set<string>();
  it("keeps an asset link whose id a lookup returned this turn, and strips one that did not", () => {
    const ids = new Set(["11111111-1111-4111-8111-111111111111"]);
    const ok = "[sw-1](/assets.html#view=asset:11111111-1111-4111-8111-111111111111)";
    const bad = "[sw-9](/assets.html#view=asset:99999999-9999-4999-8999-999999999999)";
    expect(sanitizeAnswerLinks(`${ok} and ${bad}`, pages, ids)).toBe(`${ok} and sw-9`);
    expect(sanitizeAnswerLinks(`${bad}`, pages, new Set())).toBe("sw-9");
    // Other same-origin paths are untouched.
    expect(sanitizeAnswerLinks("[Assets](/assets.html)", pages, ids)).toBe("[Assets](/assets.html)");
  });

  it("the prompt asks for the link and for honouring an IP-history hit", () => {
    const p = buildSystemPrompt({});
    expect(p).toContain("[hostname](/assets.html#view=asset:ID)");
    expect(p).toMatch(/never a guessed or\s+remembered id/);
    expect(p).toMatch(/Never dismiss such a hit as a text match/);
  });

  it("a turn strips an asset link the lookups never returned and keeps one they did", async () => {
    h.beginTurn.mockResolvedValueOnce({ question: "which switches are down?" });
    const seen = "22222222-2222-4222-8222-222222222222";
    const answer = `[sw-2](/assets.html#view=asset:${seen}) and [sw-x](/assets.html#view=asset:33333333-3333-4333-8333-333333333333) are down.`;
    h.chatCompletionRound
      .mockImplementationOnce(async () => ({ content: "", toolCalls: [{ id: "t1", type: "function", function: { name: "list_assets", arguments: "{}" } }], finishReason: "tool_calls" }))
      .mockImplementationOnce(async (_c: any, _m: any, _t: any, o: any) => { o.onText(answer); return { content: answer, toolCalls: [], finishReason: "stop" }; });
    h.runAssistantTool.mockResolvedValueOnce({ ok: true, data: { total: 1, rows: [{ id: seen, hostname: "sw-2" }] } });
    await run().p;
    expect(h.finishTurn.mock.calls[0][1].content).toBe(`[sw-2](/assets.html#view=asset:${seen}) and sw-x are down.`);
  });
});
