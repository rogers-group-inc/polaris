/**
 * tests/unit/mobileChatTab.test.ts
 *
 * The phone's Chat tab (the AI assistant, business rule 95): it explains
 * itself when no integration is enabled, streams an answer through the
 * desktop's own event reader, shows report downloads, and follows the
 * desktop's 30-minute "fresh chat, /resume to go back" rule on the shared keys.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (...p: string[]) => readFileSync(join(process.cwd(), "public", "js", ...p), "utf-8");
const MD_SRC = read("assistant-markdown.js");
const ASSISTANT_SRC = read("assistant.js");
const CHAT_SRC = read("mobile", "chat-tab.js");

const g = globalThis as any;
const flush = () => new Promise((r) => setTimeout(r, 120));

function sseBody(frames: Array<[string, unknown]>): ReadableStream<Uint8Array> {
  const text = frames.map(([ev, data]) => `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`).join("");
  return new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); } });
}

function setup(status: unknown) {
  document.body.innerHTML = '<div id="topbar"></div><div id="app-body"></div>';
  localStorage.clear();
  g.escapeHtml = (s: any) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  g.timeAgo = () => "just now";
  g._csrfHeaders = (h: any) => h;
  g.PolarisTabs = { showSnackbar: vi.fn(), attachSwipeToDismiss: vi.fn() };
  g.api = {
    assistant: {
      status: vi.fn(async () => status),
      createConversation: vi.fn(async () => ({ id: "c-new", title: "New conversation" })),
      getConversation: vi.fn(async (id: string) => ({ id, title: "Earlier", messages: [{ role: "user", content: "old question" }, { role: "assistant", content: "old answer" }] })),
      listConversations: vi.fn(async () => ({ conversations: [] })),
      stopTurn: vi.fn(async () => ({})),
      setPreferences: vi.fn(async (b: any) => ({ efficiencyAdvisor: !!b.efficiencyAdvisor, memory: true })),
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(MD_SRC)();
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(ASSISTANT_SRC)();
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(CHAT_SRC)();
  const spec = g.PolarisChatTab.spec;
  const body = document.getElementById("app-body")!;
  document.getElementById("topbar")!.innerHTML = spec.renderTopbar({});
  return { spec, body };
}

beforeEach(() => { vi.restoreAllMocks(); });

describe("mobile Chat tab", () => {
  it("says so when no AI Assistant integration is enabled", async () => {
    const { spec, body } = setup({ enabled: false, integrations: [] });
    await spec.render(body, {});
    expect(body.textContent).toMatch(/isn’t available/);
    expect(body.querySelector("#chat-input")).toBeNull();
  });

  it("streams an answer, shows lookups and a report with downloads, and remembers the conversation", async () => {
    const { spec, body } = setup({ enabled: true, integrations: [{ id: "i1", name: "Foundry", displayName: "Polaris AI" }] });
    await spec.render(body, {});
    expect(document.getElementById("chat-title")!.textContent).toBe("Polaris AI");
    g.fetch = vi.fn(async () => ({
      ok: true, status: 200,
      body: sseBody([
        ["start", { question: "what is down?" }],
        ["tool", { name: "list_assets", label: "Assets", status: "running" }],
        ["tool", { name: "list_assets", label: "Assets", status: "done", ok: true }],
        ["report", { title: "Down switches", columns: [{ key: "h", label: "Host" }], rows: [{ h: "sw-1" }], rowCount: 1 }],
        ["token", { text: "One switch **is down**." }],
        ["done", { stopped: false }],
      ]),
    }));
    const input = body.querySelector("#chat-input") as HTMLTextAreaElement;
    input.value = "what is down?";
    body.querySelector("#chat-form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    const [url, init] = g.fetch.mock.calls[0];
    expect(url).toBe("/api/v1/assistant/conversations/c-new/messages");
    expect(JSON.parse(init.body)).toEqual({ content: "what is down?" });
    expect(body.querySelector(".chat-msg.user")!.textContent).toBe("what is down?");
    expect(body.querySelector(".chat-msg.assistant .chat-bubble")!.innerHTML).toContain("<strong>is down</strong>");
    expect(body.querySelector(".chat-chip")!.textContent).toBe("Assets");
    expect(body.querySelectorAll("[data-dl]")).toHaveLength(2);
    expect(localStorage.getItem("polaris-assistant-conv")).toBe("c-new");
    expect(Number(localStorage.getItem("polaris-assistant-active"))).toBeGreaterThan(0);
  });

  it("sets an idle conversation aside after 30 minutes, and /resume brings it back", async () => {
    const { spec, body } = setup({ enabled: true, integrations: [{ id: "i1", name: "Foundry" }] });
    localStorage.setItem("polaris-assistant-conv", "c-old");
    localStorage.setItem("polaris-assistant-active", String(Date.now() - 31 * 60 * 1000));
    await spec.render(body, {});
    expect(g.api.assistant.getConversation).not.toHaveBeenCalled();
    expect(body.textContent).toMatch(/fresh chat after 30 minutes/);
    expect(JSON.parse(localStorage.getItem("polaris-assistant-resume")!).id).toBe("c-old");
    const input = body.querySelector("#chat-input") as HTMLTextAreaElement;
    input.value = "/resume";
    body.querySelector("#chat-form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(g.api.assistant.getConversation).toHaveBeenCalledWith("c-old");
    expect(body.textContent).toContain("old answer");
    expect(localStorage.getItem("polaris-assistant-resume")).toBeNull();
  });

  it("follows the integration's idle window: 10 minutes sets aside an 11-minute-idle chat; 0 never does", async () => {
    let t = setup({ enabled: true, integrations: [{ id: "i1", name: "Foundry", idleResetMinutes: 10 }] });
    localStorage.setItem("polaris-assistant-conv", "c-old");
    localStorage.setItem("polaris-assistant-active", String(Date.now() - 11 * 60 * 1000));
    await t.spec.render(t.body, {});
    expect(g.api.assistant.getConversation).not.toHaveBeenCalled();
    expect(t.body.textContent).toMatch(/fresh chat after 10 minutes/);

    t = setup({ enabled: true, integrations: [{ id: "i1", name: "Foundry", idleResetMinutes: 0 }] });
    localStorage.setItem("polaris-assistant-conv", "c-old");
    localStorage.setItem("polaris-assistant-active", String(Date.now() - 600 * 60 * 1000));
    await t.spec.render(t.body, {});
    expect(g.api.assistant.getConversation).toHaveBeenCalledWith("c-old");
  });

  it("reopens a recently active conversation as it was", async () => {
    const { spec, body } = setup({ enabled: true, integrations: [{ id: "i1", name: "Foundry" }] });
    localStorage.setItem("polaris-assistant-conv", "c-old");
    localStorage.setItem("polaris-assistant-active", String(Date.now() - 5 * 60 * 1000));
    await spec.render(body, {});
    expect(g.api.assistant.getConversation).toHaveBeenCalledWith("c-old");
    expect(body.textContent).toContain("old question");
  });

  it("continues the conversation the person used on another device within the last 30 minutes", async () => {
    const { spec, body } = setup({ enabled: true, integrations: [{ id: "i1", name: "Foundry" }] });
    g.api.assistant.listConversations = vi.fn(async () => ({ conversations: [
      { id: "c-desktop", title: "From the desktop", updatedAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(), messageCount: 2 },
    ] }));
    localStorage.setItem("polaris-assistant-conv", "c-phone-old");
    await spec.render(body, {});
    expect(g.api.assistant.getConversation).toHaveBeenCalledWith("c-desktop");
    expect(localStorage.getItem("polaris-assistant-conv")).toBe("c-desktop");
  });

  it("does not resurrect a conversation idle for over 30 minutes on every device", async () => {
    const { spec, body } = setup({ enabled: true, integrations: [{ id: "i1", name: "Foundry" }] });
    g.api.assistant.listConversations = vi.fn(async () => ({ conversations: [
      { id: "c-stale", title: "Old", updatedAt: new Date(Date.now() - 45 * 60 * 1000).toISOString(), messageCount: 4 },
    ] }));
    await spec.render(body, {});
    expect(g.api.assistant.getConversation).not.toHaveBeenCalled();
    expect(body.querySelector("#chat-input")).toBeTruthy();
  });

  it("while R.A.L.P.H. is on the tab is named R.A.L.P.H. and introduces itself in character", async () => {
    const { spec, body } = setup({ enabled: true, efficiencyAdvisor: true, integrations: [{ id: "i1", name: "Foundry", displayName: "Polaris AI" }] });
    await spec.render(body, {});
    expect(document.getElementById("chat-title")!.textContent).toBe("R.A.L.P.H.");
    expect(body.textContent).toContain("I'm R.A.L.P.H.");
    expect(body.textContent).toContain("Real-time Assesser of Labor and Productivity Habits");
    const intros: string[] = g.PolarisAssistant._RALPH_INTROS;
    expect(intros.some((l) => body.textContent!.includes(l))).toBe(true);
  });

  it("R.A.L.P.H. is a button in the top bar that glows while on and saves the switch", async () => {
    const { spec, body } = setup({ enabled: true, efficiencyAdvisor: false, integrations: [{ id: "i1", name: "Foundry" }] });
    await spec.render(body, {});
    const btn = document.getElementById("chat-ralph-btn")!;
    expect(btn.getAttribute("title")).toBe("Real-time Assesser of Labor and Productivity Habits");
    expect(btn.classList.contains("on")).toBe(false);
    btn.click();
    await flush();
    expect(g.api.assistant.setPreferences).toHaveBeenCalledWith({ efficiencyAdvisor: true });
    expect(btn.classList.contains("on")).toBe(true);
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    expect(document.getElementById("chat-title")!.textContent).toBe("R.A.L.P.H.");
    expect(body.querySelector(".chat-bubble.local")).toBeTruthy(); // the greeting note
  });
});

// A long question grows the composer to three lines; with the on-screen
// keyboard up as well, the latest answers have to stay reachable above it.
describe("mobile Chat tab — composer growth and the on-screen keyboard", () => {
  const LAYOUT_H = 800;
  let rafQueue: Array<() => void> = [];
  const flushRaf = () => { const q = rafQueue; rafQueue = []; q.forEach((fn) => fn()); };

  function fakeViewport(height: number) {
    const listeners: Record<string, Array<() => void>> = {};
    return {
      height, offsetTop: 0,
      addEventListener(type: string, fn: () => void) { (listeners[type] ||= []).push(fn); },
      removeEventListener() { /* never detached */ },
      emit(type: string) { (listeners[type] || []).forEach((fn) => fn()); },
    };
  }

  /** A scroller with real-looking metrics: happy-dom lays nothing out. */
  function scrollMetrics(el: HTMLElement, scrollHeight: number, clientHeight: number, scrollTop: number) {
    let top = scrollTop;
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => scrollHeight });
    Object.defineProperty(el, "clientHeight", { configurable: true, get: () => clientHeight });
    Object.defineProperty(el, "scrollTop", { configurable: true, get: () => top, set: (v: number) => { top = Math.min(v, scrollHeight - clientHeight); } });
  }

  async function mount() {
    const vv = fakeViewport(LAYOUT_H);
    Object.defineProperty(window, "visualViewport", { configurable: true, value: vv });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: LAYOUT_H });
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((fn: FrameRequestCallback) => { rafQueue.push(() => fn(0)); return rafQueue.length; });
    const { spec, body } = setup({ enabled: true, integrations: [{ id: "i1", name: "Foundry" }] });
    // The shell: the tab body lives inside #app, which the fit pins.
    const app = document.createElement("div");
    app.id = "app";
    document.body.appendChild(app);
    app.appendChild(body);
    await spec.render(body, {});
    flushRaf();
    return { vv, app, body };
  }
  const keyboardTo = (vv: ReturnType<typeof fakeViewport>, h: number, offsetTop = 0) => {
    vv.height = h; vv.offsetTop = offsetTop; vv.emit("resize"); flushRaf();
  };

  beforeEach(() => { rafQueue = []; });

  it("pins the shell to the visible rect while the keyboard is up, and lets go when it closes", async () => {
    const { vv, app } = await mount();
    expect(app.classList.contains("chat-kb-open")).toBe(false);
    keyboardTo(vv, 420, 30);
    expect(app.classList.contains("chat-kb-open")).toBe(true);
    expect(app.style.getPropertyValue("--chat-vv-height")).toBe("420px");
    expect(app.style.getPropertyValue("--chat-vv-offset-top")).toBe("30px");
    keyboardTo(vv, LAYOUT_H);
    expect(app.classList.contains("chat-kb-open")).toBe(false);
    expect(app.style.getPropertyValue("--chat-vv-height")).toBe("");
  });

  it("ignores a collapsing URL bar — only a keyboard-sized drop pins", async () => {
    const { vv, app } = await mount();
    keyboardTo(vv, LAYOUT_H - 80);
    expect(app.classList.contains("chat-kb-open")).toBe(false);
  });

  it("unpins once the chat is no longer on screen", async () => {
    const { vv, app, body } = await mount();
    keyboardTo(vv, 420);
    body.innerHTML = "<div>another tab</div>";
    keyboardTo(vv, 410);
    expect(app.classList.contains("chat-kb-open")).toBe(false);
  });

  it("brings the newest answer into view when the keyboard opens on a reader at the bottom", async () => {
    const { vv, app, body } = await mount();
    // The scroller is the full screen until the pin shrinks it to the visible rect
    // (writing scrollTop forces that layout in a browser, so the end is the new one).
    let top = 1200;                             // at the bottom of 2000 / 800
    const client = () => (app.classList.contains("chat-kb-open") ? 420 : 800);
    Object.defineProperty(body, "scrollHeight", { configurable: true, get: () => 2000 });
    Object.defineProperty(body, "clientHeight", { configurable: true, get: client });
    Object.defineProperty(body, "scrollTop", { configurable: true, get: () => top, set: (v: number) => { top = Math.min(v, 2000 - client()); } });
    keyboardTo(vv, 420);
    expect(body.scrollTop).toBe(1580);          // the newest answer sits on the composer, not behind the keyboard
    top = 900;                                  // the reader scrolls up to read
    keyboardTo(vv, 421);                        // a follow-up viewport event must not drag them back
    expect(body.scrollTop).toBe(900);
  });

  it("leaves a reader who had scrolled up where they were when the keyboard opens", async () => {
    const { vv, body } = await mount();
    scrollMetrics(body, 2000, 800, 300);
    keyboardTo(vv, 420);
    expect(body.scrollTop).toBe(300);
  });

  it("keeps a reader at the bottom there as the composer grows", async () => {
    const { body } = await mount();
    const input = body.querySelector("#chat-input") as HTMLTextAreaElement;
    // The content is a line taller once autosize has set the box's height —
    // the end of the log moves down while scrollTop stays where it was.
    let top = 1600;                             // at the bottom of 2000 / 400
    Object.defineProperty(body, "scrollHeight", { configurable: true, get: () => (input.style.height ? 2021 : 2000) });
    Object.defineProperty(body, "clientHeight", { configurable: true, get: () => 400 });
    Object.defineProperty(body, "scrollTop", { configurable: true, get: () => top, set: (v: number) => { top = Math.min(v, body.scrollHeight - 400); } });
    input.value = "a long question\nthat wraps";
    input.dispatchEvent(new Event("input"));
    expect(body.scrollTop).toBe(1621);          // followed the end down, not left 21px short of it
  });

  it("leaves a reader who scrolled up to read where they were", async () => {
    const { body } = await mount();
    scrollMetrics(body, 2000, 400, 300);
    const input = body.querySelector("#chat-input") as HTMLTextAreaElement;
    input.value = "a long question\nthat wraps\nand wraps";
    input.dispatchEvent(new Event("input"));
    expect(body.scrollTop).toBe(300);
  });
});
