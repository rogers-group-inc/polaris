/**
 * tests/unit/mobileMoreTabAccountTags.test.ts — the More tab's Account row
 * shows the account's tag scope under its role.
 *
 * The set is the EFFECTIVE one /auth/me resolves (role ∪ user ∪ SSO group),
 * carried on the mobile session as `user.regions` and `user.tags`. Pinned:
 *
 *   • regions render before free-form tags, each as its own pill, and the two
 *     are told apart by class (and title);
 *   • an account with neither renders no pill row at all;
 *   • tag text is escaped.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(process.cwd(), "public", "js", "mobile", "more-tab.js"), "utf-8");
const g = globalThis as any;

async function render(user: Record<string, unknown>) {
  document.body.innerHTML = '<div id="app"><main class="app-body" id="app-body"></main></div>';
  g.escapeHtml = (s: any) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  g.timeAgo = () => "just now";
  g._csrfHeaders = () => ({});
  g.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
  g.api = {
    alerts: { list: vi.fn(async () => ({ notifications: [] })) },
    push: { preference: vi.fn(async () => ({ preference: "email" })), setPreference: vi.fn() },
  };
  g.PolarisRouter = { go: vi.fn() };
  g.PolarisTabs = { showSnackbar: vi.fn() };
  g.PolarisTheme = { get: () => "dark", set: vi.fn() };
  g.PolarisInstall = {
    isIos: () => false, isFirefox: () => false, isStandalone: () => false,
    canPrompt: () => false, prompt: vi.fn(), onChange: vi.fn(),
  };
  g.polarisPush = {
    isSupported: () => false,
    status: vi.fn(async () => ({ supported: false, enabledOnServer: false, permission: "default", subscribed: false })),
    enable: vi.fn(), disable: vi.fn(), syncToPreference: vi.fn(async () => ""),
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(SRC)();
  const body = document.getElementById("app-body")!;
  await (g.PolarisMoreTab.spec.render(body, { route: { parts: [] }, user: { username: "dm", role: "Operator", ...user } }) as any);
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
}

const pills = () => Array.from(document.querySelectorAll(".account-tags .account-tag")) as HTMLElement[];

beforeEach(() => { document.body.innerHTML = ""; });

describe("More tab account tags", () => {
  it("lists regions then tags under the role", async () => {
    await render({ regions: ["Central", "East"], tags: ["noc"] });
    const p = pills();
    expect(p.map((e) => e.textContent)).toEqual(["Central", "East", "noc"]);
    expect(p.map((e) => e.classList.contains("region"))).toEqual([true, true, false]);
    expect(p[0].title).toBe("Region");
    expect(p[2].title).toBe("Tag");
    // Sits inside the Account row, after the role line.
    const content = document.querySelector(".account-tags")!.parentElement!;
    expect(content.querySelector(".supporting")!.textContent).toBe("Operator");
  });

  it("shows tags alone when the account has no regions", async () => {
    await render({ regions: [], tags: ["lab"] });
    expect(pills().map((e) => e.textContent)).toEqual(["lab"]);
  });

  it("renders no pill row for an account with no tag scope", async () => {
    await render({ regions: [], tags: [] });
    expect(document.querySelector(".account-tags")).toBeNull();
    await render({});
    expect(document.querySelector(".account-tags")).toBeNull();
  });

  it("escapes tag text", async () => {
    await render({ tags: ['<img src=x onerror="x">'] });
    expect(document.querySelector(".account-tags img")).toBeNull();
    expect(pills()[0].textContent).toBe('<img src=x onerror="x">');
  });
});
