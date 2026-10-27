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
let sandbox: any;

beforeAll(() => {
  sandbox = { window: {}, TextDecoder, TextEncoder };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of ["assistant-markdown.js", "assistant.js"]) {
    const src = readFileSync(resolve(__dirname, "../../public/js", f), "utf8");
    new vm.Script(src, { filename: f }).runInContext(sandbox);
  }
  MD = sandbox.window.PolarisMarkdown;
  A = sandbox.window.PolarisAssistant;
});

// The page's sticky top bar (z-index 1050) covers the panel (950); a panel
// whose top went under it lost its title bar and resize grip — the only two
// handles — and could not be moved or shrunk back.
describe("panel top limit (clears the sticky top bar)", () => {
  function withBar(rect: { top: number; bottom: number; height: number } | null, innerHeight = 900) {
    sandbox.window.innerHeight = innerHeight;
    sandbox.document = {
      querySelector: (sel: string) =>
        sel === ".page-top-sticky" && rect ? { getBoundingClientRect: () => rect } : null,
    };
  }

  it("sits 8px below the bar's bottom edge", () => {
    withBar({ top: 0, bottom: 112, height: 112 });
    expect(A._topLimit()).toBe(120);
  });

  it("falls back to 8px on a page with no bar", () => {
    withBar(null);
    expect(A._topLimit()).toBe(8);
  });

  it("ignores a bar that is not laid out", () => {
    withBar({ top: 0, bottom: 0, height: 0 });
    expect(A._topLimit()).toBe(8);
  });

  it("ignores a bar that is not at the top of the window", () => {
    withBar({ top: 600, bottom: 700, height: 100 });
    expect(A._topLimit()).toBe(8);
  });
});

// The panel belongs to the layout column (16:9 / 16:10 / Auto), like the
// button and the toasts: a moved panel is saved as an offset from the
// column's right edge, so it follows a layout change, and is kept inside the
// column. Seen 2026-10-26: a panel moved once before reopened in the WINDOW's
// bottom-right corner, out in the margin of a 16:9 layout on a wide screen.
describe("panel placement (inside the layout column)", () => {
  // 2560-wide window, 16:9 column 320..2240, 1080 high, bar clears at 120.
  const col = { left: 320, right: 2240 };
  const size = { width: 400, height: 600 };
  const place = (saved: Record<string, number>, c = col) => A._panelPlacement(saved, size, c, 120, 1080);

  it("an old window-pixel position in the window corner is pulled into the column and re-saved column-relative", () => {
    // Where the panel used to sit: 24px from the WINDOW's right and bottom.
    const r = place({ left: 2560 - 24 - 400, top: 1080 - 24 - 600 });
    expect(r).toMatchObject({ left: 2240 - 8 - 400, top: 456 });
    expect(r.saved).toEqual({ right: 8, bottom: 24 });
  });

  it("a column-relative position follows the column when the layout changes", () => {
    const saved = { right: 24, bottom: 24 };
    expect(place(saved).left).toBe(2240 - 24 - 400);
    // Auto: the column is the whole window.
    expect(place(saved, { left: 0, right: 2560 }).left).toBe(2560 - 24 - 400);
  });

  it("is kept inside the column on the left, and below the sticky bar", () => {
    expect(place({ left: 10, top: 5 })).toMatchObject({ left: 328, top: 120 });
  });

  it("a panel wider than the column still starts at the column's left edge", () => {
    expect(A._panelPlacement({ right: 0, bottom: 0 }, { width: 2000, height: 600 }, col, 120, 1080).left).toBe(328);
  });
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
    expect(A.matchCommands("/re").map((c: any) => c.name)).toEqual(["resume", "retry", "report", "rename", "remember"]);
    expect(A.matchCommands("/zz")).toEqual([]);
    expect(A.matchCommands("/report x")).toBeNull();
    expect(A.matchCommands("hello")).toBeNull();
  });

  it("offers clear, new, resume, history, retry, report, docs, export, rename, delete, model, memory, remember and help", () => {
    expect(A.COMMANDS.map((c: any) => c.name).sort()).toEqual(
      ["clear", "delete", "docs", "export", "help", "history", "memory", "model", "new", "remember", "rename", "report", "resume", "retry"],
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

  it("uses the integration's own window, and 0 means never", () => {
    const now = Date.parse("2026-10-09T12:00:00Z");
    expect(A._idleExpired(String(now - 11 * 60 * 1000), now, 10 * 60 * 1000)).toBe(true);
    expect(A._idleExpired(String(now - 9 * 60 * 1000), now, 10 * 60 * 1000)).toBe(false);
    expect(A._idleExpired(String(now - 999 * 60 * 1000), now, 0)).toBe(false);
    expect(A._idleWindowText(30 * 60000)).toBe("30 minutes");
    expect(A._idleWindowText(60 * 60000)).toBe("1 hour");
    expect(A._idleWindowText(120 * 60000)).toBe("2 hours");
    expect(A._idleWindowText(90 * 60000)).toBe("90 minutes");
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

  it("offers only the formats asked for, and holds a PDF's buttons until the PDF writer has loaded", async () => {
    const rep = (formats?: string[]) => ({ title: "T", columns: [{ key: "a", label: "A" }], rows: [{ a: "x" }], rowCount: 1, truncated: false, formats });
    const kinds = (html: string) => [...html.matchAll(/data-dl="(\w+)"/g)].map((m) => m[1]);
    expect(kinds(A._messageHTML({ role: "assistant", content: "", reports: [rep(["csv"])] }, 0, false))).toEqual(["csv"]);
    // The first PDF report starts the load and waits behind one line…
    const waiting = A._messageHTML({ role: "assistant", content: "", reports: [rep(["pdf"])] }, 0, false);
    expect(waiting).toContain("Preparing PDF…");
    expect(kinds(waiting)).toEqual([]);
    // …and once the load settles (here it fails: no loader on this page) the button shows.
    await new Promise((r) => setTimeout(r, 0));
    expect(kinds(A._messageHTML({ role: "assistant", content: "", reports: [rep(["pdf"])] }, 0, false))).toEqual(["pdf"]);
    expect(kinds(A._messageHTML({ role: "assistant", content: "", reports: [rep()] }, 0, false))).toEqual(["csv", "pdf", "md"]);
  });

  it("escapes backslashes before pipes, so an escaped pipe can't open a column", () => {
    const md = A._reportToMarkdown({ title: "T", columns: [{ key: "a", label: "A" }], rows: [{ a: "C:\\temp\\|x" }], rowCount: 1, truncated: false });
    expect(md).toContain("| C:\\\\temp\\\\\\|x |");
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
    expect(A._ADVISOR_GREETINGS).toContain("Activating R.A.L.P.H. Enabling infinite patience protocol.");
    expect(A._ADVISOR_GREETINGS).toContain("Hello. I am here to help you reach your full potential. I will probably fail.");
    expect(A._ADVISOR_FAREWELLS).toHaveLength(8);
    expect(A._ADVISOR_FAREWELLS).toContain("R.A.L.P.H. disengaged. Your decline has been noted.");
    const html = A._messageHTML({ role: "assistant", content: A._ADVISOR_GREETINGS[0], local: true }, 0, false);
    expect(html).toContain("border-style:dashed");
    expect(html).toContain("Thank you for activating R.A.L.P.H.");
  });

  it("shows the advisor as a R.A.L.P.H. toggle button, spelled out on hover, glowing while on", () => {
    const src = readFileSync(resolve(__dirname, "../../public/js/assistant.js"), "utf8");
    const css = readFileSync(resolve(__dirname, "../../public/css/assistant.css"), "utf8");
    expect(src).toContain('<button type="button" class="asst-ralph" data-r="advisor" aria-pressed="false" title="Real-time Assesser of Labor and Productivity Habits">R.A.L.P.H.</button>');
    expect(src).toContain('S.els.advisor.addEventListener("click", setAdvisor)');
    expect(css).toMatch(/\.asst-ralph\.on \{[^}]*box-shadow/);
    expect([...A._ADVISOR_GREETINGS, ...A._ADVISOR_FAREWELLS].join(" ")).not.toMatch(/Efficiency Advisor/);
  });

  it("carries the requested loading lines", () => {
    for (const l of ["Overcoming reluctance…", "Dividing by zero…", "Obsessing over what to wear…", "Reprogramming the programmables…"]) {
      expect(A._LOADING_LINES).toContain(l);
    }
  });
});

// Rule 95(l): pasted screenshots.
describe("screenshots", () => {
  const item = (type: string) => ({ kind: "file", type, getAsFile: () => ({ type, name: "x" }) });

  it("fitWithin caps the long edge and keeps the aspect ratio", () => {
    expect({ ...A._fitWithin(3136, 1764, 1568) }).toEqual({ w: 1568, h: 882 });
    expect({ ...A._fitWithin(1764, 3136, 1568) }).toEqual({ w: 882, h: 1568 });
    expect({ ...A._fitWithin(800, 600, 1568) }).toEqual({ w: 800, h: 600 });
  });

  it("imageFilesFrom takes a pasted screenshot's image", () => {
    const files = A._imageFilesFrom({ types: ["Files"], items: [item("image/png")] });
    expect(files.length).toBe(1);
    expect(files[0].type).toBe("image/png");
  });

  it("imageFilesFrom attaches nothing when the clipboard also carries text (an Excel or Word copy)", () => {
    expect(A._imageFilesFrom({ types: ["text/plain", "text/html", "Files"], items: [item("image/png")] }).length).toBe(0);
  });

  it("imageFilesFrom ignores files that are not images", () => {
    expect(A._imageFilesFrom({ types: ["Files"], items: [item("application/pdf")] }).length).toBe(0);
  });

  it("a user message draws its screenshots above the text, and an image-only message has no empty bubble", () => {
    const withText = A._messageHTML({ role: "user", content: "why?", images: [{ url: "blob:abc" }] }, 0, false);
    expect(withText).toContain('<img src="blob:abc" alt="Screenshot">');
    expect(withText.indexOf("asst-shots")).toBeLessThan(withText.indexOf("asst-bubble"));
    const only = A._messageHTML({ role: "user", content: "", images: [{ url: "blob:abc" }] }, 0, false);
    expect(only).not.toContain("asst-bubble");
  });
});
