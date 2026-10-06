/**
 * tests/unit/mobileAlertsAckDom.test.ts
 *
 * The mobile Alerts tab (#alerts; formerly the #more/alerts sub-page) — the
 * surface a web push actually lands on. It was read-only, which meant the
 * person holding the pager could see the alert but not stop an escalation
 * chain set to stopOn:"acknowledge".
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(process.cwd(), "public", "js", "mobile", "alerts-tab.js"), "utf-8");
// The note prompt this page opens lives in mobile/alerts.js (shared with the
// per-asset alerts sheet), and the toolbar in list-controls.js, so the harness
// loads them the way mobile.html does.
const ALERTS_SRC = readFileSync(join(process.cwd(), "public", "js", "mobile", "alerts.js"), "utf-8");
const LIST_CONTROLS_SRC = readFileSync(join(process.cwd(), "public", "js", "mobile", "list-controls.js"), "utf-8");

const g = globalThis as any;

const ALERTS = [
  { id: "n1", severity: "critical", message: "packet loss at 93.8%", assetId: "a1", assetHostname: "PINERUN-222E-4", triggeredAt: "2026-08-12T10:00:00Z", acknowledged: false },
  { id: "n2", severity: "warning", message: "cpu high", assetId: null, assetHostname: "sw-2", triggeredAt: "2026-08-12T09:00:00Z", acknowledged: true, acknowledgedBy: "jsmith" },
];

async function render(opts?: { perm?: string; ackFails?: boolean; alerts?: any[] }) {
  document.body.innerHTML = '<div id="app"><main class="app-body" id="app-body"></main></div>';
  const snacks: string[] = [];
  const acked: any[] = [];

  g.escapeHtml = (s: any) => String(s ?? "");
  g.timeAgo = () => "just now";
  g._csrfHeaders = () => ({});
  g.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
  g.api = {
    alerts: {
      list: vi.fn(async () => ({ notifications: opts?.alerts ?? ALERTS })),
      acknowledge: vi.fn(async (ids: string[], note?: string) => {
        acked.push({ ids, note });
        if (opts?.ackFails) throw new Error("nope");
        // The list re-renders after a successful ack.
        (opts?.alerts ?? ALERTS)[0].acknowledged = true;
        return { acknowledged: 1 };
      }),
    },
  };
  g.PolarisRouter = { go: vi.fn() };
  g.PolarisTabs = { showSnackbar: (m: string) => snacks.push(m) };
  g.PolarisTheme = { get: () => "dark", set: vi.fn() };
  g.PolarisInstall = { isIos: () => false, isFirefox: () => false, isStandalone: () => false, canPrompt: () => false, prompt: vi.fn(), onChange: vi.fn() };
  g.polarisPush = { isSupported: () => false, status: vi.fn(async () => ({ supported: false, enabledOnServer: false, permission: "default", subscribed: false })), enable: vi.fn(), disable: vi.fn() };

  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(ALERTS_SRC)();
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(LIST_CONTROLS_SRC)();
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(SRC)();
  const body = document.getElementById("app-body")!;
  await (g.PolarisAlertsTab.spec.render(body, {
    route: { name: "alerts", parts: [] },
    user: { username: "u", permissions: { alerts: opts?.perm ?? "write" } },
  }) as any);
  await new Promise((r) => setTimeout(r, 0));
  return { body, snacks, acked };
}

const ackButtons = () => Array.from(document.querySelectorAll("[data-ack]")) as HTMLElement[];

beforeEach(() => {
  document.body.innerHTML = "";
  ALERTS[0].acknowledged = false;
  try { localStorage.clear(); } catch { /* happy-dom always has it */ }
});

describe("mobile alerts acknowledge", () => {
  it("offers Ack only on unacknowledged rows", async () => {
    await render();
    expect(ackButtons().map((b) => b.dataset.ack)).toEqual(["n1"]);
  });

  it("names who acknowledged the ones already handled", async () => {
    await render();
    expect(document.body.textContent).toContain("acknowledged by jsmith");
  });

  it("hides the control from a viewer who can only read alerts", async () => {
    await render({ perm: "read" });
    expect(ackButtons()).toHaveLength(0);
    // …but the alert itself is still listed.
    expect(document.body.textContent).toContain("packet loss at 93.8%");
  });

  it("acknowledges and re-renders, without opening the device", async () => {
    const { acked, snacks } = await render();
    ackButtons()[0]!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(acked).toEqual([{ ids: ["n1"], note: undefined }]);
    expect(snacks[0]).toMatch(/acknowledged/i);
    expect(g.PolarisRouter.go).not.toHaveBeenCalled();
    // Re-rendered: the row it acknowledged no longer offers the button.
    expect(ackButtons()).toHaveLength(0);
  });

  it("keeps the Ack button usable when the request fails", async () => {
    const { snacks } = await render({ ackFails: true });
    const btn = ackButtons()[0]!;
    btn.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(snacks[0]).toBe("nope");
    expect((btn as HTMLButtonElement).disabled).toBe(false);
    expect(btn.textContent).toBe("Ack");
  });

  it("keeps the Ack control OUT of the row button (nested buttons swallow the tap)", async () => {
    await render();
    const nested = document.querySelector(".list-item [data-ack]");
    expect(nested).toBeNull();
  });

  it("stays ONE TAP when the automation doesn't demand a note", async () => {
    const { acked } = await render();
    ackButtons()[0]!.click();
    await new Promise((r) => setTimeout(r, 0));
    // No sheet: this is the path for someone who just got paged.
    expect(document.querySelector("#ack-note")).toBeNull();
    expect(acked).toEqual([{ ids: ["n1"], note: undefined }]);
  });

  it("opens a note sheet — not window.prompt — when the automation requires one", async () => {
    // prompt() is unstyled and some browsers suppress it outright in an
    // installed PWA, which would leave the operator unable to acknowledge with
    // no visible reason why. And without the sheet the server refuses the
    // request, so the button would simply fail.
    const alerts = [{ id: "n5", severity: "critical", message: "loss", assetId: "a1", assetHostname: "SW-1", triggeredAt: "2026-08-12T10:00:00Z", acknowledged: false, requireAckNote: true }];
    g.window.prompt = vi.fn();
    const { acked } = await render({ alerts });
    expect(ackButtons()[0]!.dataset.noteRequired).toBe("1");
    ackButtons()[0]!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(g.window.prompt).not.toHaveBeenCalled();
    const ta = document.querySelector("#ack-note") as HTMLTextAreaElement;
    expect(ta).toBeTruthy();
    expect(ta.placeholder).toBe("What is the problem and what is the fix?");
    expect(acked).toEqual([]); // nothing sent until the sheet is answered

    // Empty submit is a correction, not a send.
    (document.querySelector("#ack-note-ok") as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(acked).toEqual([]);
    expect((document.querySelector("#ack-note-err") as HTMLElement).style.display).toBe("");

    ta.value = "bad optic, swapped it";
    (document.querySelector("#ack-note-ok") as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(acked).toEqual([{ ids: ["n5"], note: "bad optic, swapped it" }]);
    expect(document.querySelector("#ack-note")).toBeNull(); // sheet closed
  });

  it("sends nothing when the note sheet is dismissed", async () => {
    const alerts = [{ id: "n6", severity: "critical", message: "loss", assetId: "a1", assetHostname: "SW-1", triggeredAt: "2026-08-12T10:00:00Z", acknowledged: false, requireAckNote: true }];
    const { acked } = await render({ alerts });
    ackButtons()[0]!.click();
    await new Promise((r) => setTimeout(r, 0));
    (document.querySelector(".scrim") as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(acked).toEqual([]);
    // The button is left usable — it was never disabled.
    expect((ackButtons()[0] as HTMLButtonElement).disabled).toBe(false);
  });
});
