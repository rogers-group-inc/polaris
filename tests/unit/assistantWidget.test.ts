/**
 * tests/unit/assistantWidget.test.ts
 *
 * The browser half of the AI assistant (business rule 95), loaded through
 * node:vm the way automationSentences.test.ts loads its module:
 *   - assistant-markdown.js escapes FIRST — model output that carries HTML,
 *     script, event handlers or javascript: links renders as inert text;
 *   - assistant.js's slash parsing + popup filtering, the SSE frame reader,
 *     and the CSV formula guard on report cells.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";

let MD: { render: (s: string) => string };
let A: any;

beforeAll(() => {
  const sandbox: any = { window: {}, TextDecoder, TextEncoder };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of ["assistant-markdown.js", "assistant.js"]) {
    const src = readFileSync(resolve(__dirname, "../../public/js", f), "utf8");
    new vm.Script(src, { filename: f }).runInContext(sandbox);
  }
  MD = sandbox.window.PolarisMarkdown;
  A = sandbox.window.PolarisAssistant;
});

describe("PolarisMarkdown — escape first", () => {
  it.each([
    "<script>alert(1)</script>",
    '<img src=x onerror="alert(1)">',
    "<a href=\"javascript:alert(1)\">x</a>",
    "**<b onmouseover=alert(1)>bold</b>**",
    "| a |\n|---|\n| <svg onload=alert(1)> |",
  ])("renders %s inert", (input) => {
    const html = MD.render(input);
    // Every real tag is one of the renderer's fixed set…
    const tags = html.match(/<[^>]*>/g) ?? [];
    for (const t of tags) {
      expect(t).toMatch(/^<\/?(p|br|strong|em|code|pre|ul|ol|li|h[4-6]|blockquote|a|div|table|thead|tbody|tr|th|td)(\s|>)/);
      // …and none of them carries an event handler.
      expect(t).not.toMatch(/\son\w+=/i);
    }
  });

  it("refuses javascript: and data: links but keeps http(s) and same-origin ones", () => {
    expect(MD.render("[x](javascript:alert(1))")).not.toContain("<a ");
    expect(MD.render("[x](data:text/html,hi)")).not.toContain("<a ");
    expect(MD.render("[x](//evil.example/a)")).not.toContain("<a ");
    expect(MD.render("[Wiki](https://github.com/x/wiki/Page#a)")).toContain('<a href="https://github.com/x/wiki/Page#a" target="_blank" rel="noopener noreferrer">Wiki</a>');
    expect(MD.render("[Assets](/assets.html)")).toContain('href="/assets.html"');
  });

  it("renders the shapes a chat answer uses", () => {
    expect(MD.render("# Title")).toBe("<h4>Title</h4>");
    expect(MD.render("- a\n- **b**")).toBe("<ul><li>a</li><li><strong>b</strong></li></ul>");
    expect(MD.render("1. one\n2. two")).toBe("<ol><li>one</li><li>two</li></ol>");
    expect(MD.render("use `a<b>`")).toBe("<p>use <code>a&lt;b&gt;</code></p>");
    expect(MD.render("```\n<x>\n```")).toBe('<pre class="asst-code"><code>&lt;x&gt;</code></pre>');
    expect(MD.render("| h1 | h2 |\n| --- | --- |\n| a | b |")).toContain("<th>h1</th><th>h2</th>");
  });

  it("copes with an unterminated fence mid-stream", () => {
    expect(MD.render("```\npartial")).toBe('<pre class="asst-code"><code>partial</code></pre>');
  });
});

describe("slash commands", () => {
  it("parses a command and its argument", () => {
    expect(A.parseSlash("/report switches down today")).toEqual({ name: "report", arg: "switches down today" });
    expect(A.parseSlash("/CLEAR")).toEqual({ name: "clear", arg: "" });
    expect(A.parseSlash("what about /clear")).toBeNull();
    expect(A.parseSlash("/")).toBeNull();
  });

  it("filters the popup by prefix while the command name is being typed", () => {
    expect(A.matchCommands("/").length).toBe(A.COMMANDS.length);
    expect(A.matchCommands("/re").map((c: any) => c.name)).toEqual(["resume", "retry", "report", "rename"]);
    expect(A.matchCommands("/zz")).toEqual([]);
    expect(A.matchCommands("/report x")).toBeNull();
    expect(A.matchCommands("hello")).toBeNull();
  });

  it("offers clear, new, resume, history, retry, report, docs, export, rename, delete, model and help", () => {
    expect(A.COMMANDS.map((c: any) => c.name).sort()).toEqual(
      ["clear", "delete", "docs", "export", "help", "history", "model", "new", "rename", "report", "resume", "retry"],
    );
    for (const c of A.COMMANDS) expect(c.desc.length).toBeGreaterThan(10);
  });

  it("sets a conversation aside after 30 idle minutes, never without an activity stamp", () => {
    const now = Date.parse("2026-10-09T12:00:00Z");
    expect(A._IDLE_RESET_MS).toBe(30 * 60 * 1000);
    expect(A._idleExpired(String(now - 30 * 60 * 1000), now)).toBe(true);
    expect(A._idleExpired(String(now - 29 * 60 * 1000), now)).toBe(false);
    expect(A._idleExpired(null, now)).toBe(false);
    expect(A._idleExpired("garbage", now)).toBe(false);
  });
});

describe("readEventStream", () => {
  it("parses frames split across chunks", async () => {
    const enc = new TextEncoder();
    const parts = ['event: token\ndata: {"te', 'xt":"Hi"}\n\nevent: tool\ndata: {"name":"search","status":"running"}\n\n: keep-alive\n\n', 'event: done\ndata: {"messageId":"m"}\n\n'];
    const body = new ReadableStream({ start(c) { for (const p of parts) c.enqueue(enc.encode(p)); c.close(); } });
    const seen: Array<[string, any]> = [];
    await A.readEventStream(body, (e: string, d: any) => seen.push([e, d]));
    expect(seen).toEqual([["token", { text: "Hi" }], ["tool", { name: "search", status: "running" }], ["done", { messageId: "m" }]]);
  });
});

describe("report downloads", () => {
  it("neutralizes spreadsheet formulas in CSV cells", () => {
    expect(A._csvSafe("=HYPERLINK(\"x\")")).toBe("'=HYPERLINK(\"x\")");
    expect(A._csvSafe("+1")).toBe("'+1");
    expect(A._csvSafe("fw-01")).toBe("fw-01");
    expect(A._csvSafe(null)).toBe("");
  });

  it("writes a Markdown table that escapes pipes", () => {
    const md = A._reportToMarkdown({ title: "T", columns: [{ key: "a", label: "A" }], rows: [{ a: "x|y" }], rowCount: 1, truncated: false });
    expect(md).toContain("| A |");
    expect(md).toContain("| x\\|y |");
  });
});

describe("Efficiency Advisor lines (rule 95(h))", () => {
  it("shows the before-lookup line above the answer and the sign-off below it, escaped", () => {
    const html = A._messageHTML({ role: "assistant", content: "42 networks.", preface: "Do <b>not</b> touch", signOff: "Adequate. For a human." }, 0, false);
    expect(html.indexOf("asst-preface")).toBeLessThan(html.indexOf("42 networks."));
    expect(html.indexOf("42 networks.")).toBeLessThan(html.indexOf("Adequate. For a human."));
    expect(html).toContain("Do &lt;b&gt;not&lt;/b&gt; touch");
  });

  it("swaps the Thinking… placeholder for the current loading line while waiting", () => {
    expect(A._messageHTML({ role: "assistant", content: "", live: true }, 0, true)).toContain("Thinking…");
    expect(A._messageHTML({ role: "assistant", content: "", live: true, loading: "Dividing by zero…" }, 0, true)).toContain("Dividing by zero…");
  });

  it("carries the owner-approved greetings and farewells, and a greeting renders as an unstored local note", () => {
    expect(A._ADVISOR_GREETINGS).toHaveLength(12);
    expect(A._ADVISOR_GREETINGS).toContain("Activating Efficiency Advisor. Enabling infinite patience protocol.");
    expect(A._ADVISOR_GREETINGS).toContain("Hello. I am here to help you reach your full potential. I will probably fail.");
    expect(A._ADVISOR_FAREWELLS).toHaveLength(8);
    expect(A._ADVISOR_FAREWELLS).toContain("Efficiency Advisor disengaged. Your decline has been noted.");
    const html = A._messageHTML({ role: "assistant", content: A._ADVISOR_GREETINGS[0], local: true }, 0, false);
    expect(html).toContain("border-style:dashed");
    expect(html).toContain("Thank you for activating the Efficiency Advisor.");
  });

  it("carries the requested loading lines", () => {
    for (const l of ["Overcoming reluctance…", "Dividing by zero…", "Obsessing over what to wear…", "Reprogramming the programmables…"]) {
      expect(A._LOADING_LINES).toContain(l);
    }
  });
});
