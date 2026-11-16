/**
 * tests/unit/automationsScriptTestRun.test.ts — the Scripts tab's Test run
 * (public/js/automations.js → runScriptTest / pickTestRunEmailChannel):
 * arguments are asked for and sent as one string, and — business rule 190 —
 * an email channel is offered only when one exists, and choosing it sends
 * `emailChannelId` (the server then emails the tester alone). Cancel at either
 * step queues nothing.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const g = globalThis as Record<string, any>;
const testRun = vi.fn(async () => ({ runId: "run1" }));
let channels: Array<Record<string, unknown>> = [];
let promptAnswer: string | null = "";
let choiceAnswer: string | null = "none";
const choiceCalls: Array<{ message: string; opts: any }> = [];

beforeAll(() => {
  const win = new Window();
  win.document.body.innerHTML = '<button id="btn-refresh"></button><div class="script-test-out" data-id="s1"></div><button id="b"></button>';
  g.window = win;
  g.document = win.document;
  g.escapeHtml = (s: unknown) => String(s ?? "");
  g.showToast = () => {};
  g.showConfirm = async () => true;
  g.showPrompt = async () => promptAnswer;
  g.showChoice = async (message: string, opts: unknown) => { choiceCalls.push({ message, opts }); return choiceAnswer; };
  g.permAtLeast = () => false; // keeps the rules tab from wiring at load; runScriptTest checks no permission
  g.api = {
    deliveryChannels: { list: async () => ({ channels }) },
    automationScripts: { testRun, run: async () => ({ run: { status: "succeeded", exitCode: 0, stdout: "", stderr: "" } }) },
  };
  (0, eval)(readFileSync(resolve(__dirname, "../../public/js/automations.js"), "utf8"));
});

beforeEach(() => {
  testRun.mockClear();
  choiceCalls.length = 0;
  promptAnswer = "";
  choiceAnswer = "none";
  channels = [];
});

const sc = { id: "s1", name: "cert-mail", runTarget: "server" };
const btn = () => g.document.getElementById("b");

describe("Scripts tab test run", () => {
  it("sends the typed arguments as one string, and asks nothing about email without an email channel", async () => {
    channels = [{ id: "p1", name: "Push", type: "web_push", enabled: true }];
    promptAnswer = "target=intranet.example.com\ndry_run=1";
    await g.runScriptTest(sc, btn());
    expect(choiceCalls).toHaveLength(0);
    expect(testRun).toHaveBeenCalledWith("s1", { args: "target=intranet.example.com\ndry_run=1" });
  });

  it("offers each enabled email channel, and sends the chosen one", async () => {
    channels = [
      { id: "c1", name: "Corp relay", type: "smtp", enabled: true },
      { id: "c2", name: "M365", type: "oauth_m365", enabled: true },
      { id: "c3", name: "Old relay", type: "smtp", enabled: false },
    ];
    choiceAnswer = "ch:c2";
    await g.runScriptTest(sc, btn());
    const labels = choiceCalls[0]!.opts.choices.map((c: { label: string }) => c.label);
    expect(labels).toEqual(["Run without email", "Allow email to me via Corp relay", "Allow email to me via M365"]);
    expect(choiceCalls[0]!.message).toMatch(/only to you/);
    expect(testRun).toHaveBeenCalledWith("s1", { args: null, emailChannelId: "c2" });
  });

  it("runs without email when asked to", async () => {
    channels = [{ id: "c1", name: "Corp relay", type: "smtp", enabled: true }];
    choiceAnswer = "none";
    await g.runScriptTest(sc, btn());
    expect(testRun).toHaveBeenCalledWith("s1", { args: null });
  });

  it("queues nothing when either dialog is cancelled", async () => {
    promptAnswer = null;
    await g.runScriptTest(sc, btn());
    channels = [{ id: "c1", name: "Corp relay", type: "smtp", enabled: true }];
    promptAnswer = "";
    choiceAnswer = null;
    await g.runScriptTest(sc, btn());
    expect(testRun).not.toHaveBeenCalled();
  });
});
