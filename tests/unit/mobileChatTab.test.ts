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
