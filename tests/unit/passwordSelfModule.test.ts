/**
 * tests/unit/passwordSelfModule.test.ts — the shared self-service password
 * module (public/js/password-self.js).
 *
 * Two things live in that file and both are pinned here.
 *
 * The CHECKLIST is the client half of the server's password policy. It used to
 * be private to users.js (one page), and the reason it moved is that a second
 * copy of five regexes is how a hint drifts from the gate it is describing.
 * Since the bar became operator-configurable (2026-09) it has two halves to
 * get right: the SHIPPED DEFAULTS, which is what a checklist shows before (or
 * instead of) a successful policy fetch, and the REPAINT that happens when the
 * live policy lands and turns out to differ. A checklist that kept showing the
 * defaults on an install with a 20-character minimum would be telling users
 * their password is fine right up until the server refuses it.
 *
 * The MODAL must not send a request the server is going to refuse: every
 * client-side guard (blank current, weak new, mismatched confirm, unchanged)
 * is checked for the absence of the call, not just for the toast. The button
 * also has to come back enabled after a failure, or a user who fat-fingers
 * their current password is stuck with a dead dialog.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(process.cwd(), "public", "js", "password-self.js"), "utf-8");

interface Harness {
  modals: { title: string; body: string; footer: string }[];
  toasts: { msg: string; kind?: string }[];
  sent: Record<string, string>[];
  changed: number;
}

function load(opts: { changeError?: string; revoked?: number; policy?: Record<string, unknown> | null } = {}) {
  const h: Harness = { modals: [], toasts: [], sent: [], changed: 0 };
  const g = globalThis as Record<string, unknown>;

  // The policy fetch the module fires on first render. Stubbed for every case,
  // not just the policy ones: left real it would be a network call from a unit
  // test, and the module's own catch would hide that it happened.
  g.fetch = vi.fn(async () => (opts.policy === null || opts.policy === undefined
    ? { ok: false, json: async () => ({}) }
    : { ok: true, json: async () => opts.policy }));

  g.api = {
    auth: {
      changePassword: vi.fn(async (body: Record<string, string>) => {
        h.sent.push(body);
        if (opts.changeError) throw new Error(opts.changeError);
        return { ok: true, otherSessionsRevoked: opts.revoked ?? 0 };
      }),
    },
  };
  g.escapeHtml = (s: string) => String(s);
  g.showToast = (msg: string, kind?: string) => { h.toasts.push({ msg, kind }); };
  g.val = (id: string) => ((document.getElementById(id) as HTMLInputElement) || { value: "" }).value.trim();
  g.currentUsername = "test_appdev";
  g.openModal = (title: string, body: string, footer: string) => {
    h.modals.push({ title, body, footer });
    document.body.innerHTML = '<div id="modal">' + body + footer + "</div>";
  };
  g.closeModal = () => { document.body.innerHTML = ""; };

  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(SRC)();
  const mod = (globalThis as Record<string, unknown>).PolarisPasswordSelf as Record<string, any>;
  return { ...h, mod, onChange: () => { h.changed++; } };
}

/** Fill the open modal and click Change Password, awaiting the handler. */
async function submit(fields: { current?: string; next?: string; confirm?: string }) {
  (document.getElementById("f-pw-current") as HTMLInputElement).value = fields.current ?? "";
  (document.getElementById("f-pw-new") as HTMLInputElement).value = fields.next ?? "";
  (document.getElementById("f-pw-new-confirm") as HTMLInputElement).value = fields.confirm ?? "";
  const btn = document.getElementById("btn-pw-save") as HTMLButtonElement;
  btn.click();
  // The click handler is async; let its microtasks drain.
  await new Promise((r) => setTimeout(r, 0));
  return btn;
}

describe("the complexity checklist", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("names every rule passwordPolicySchema enforces", () => {
    const h = load();
    document.body.innerHTML = h.mod.rulesHTML("checks");
    const keys = Array.from(document.querySelectorAll("#checks [data-rule]")).map((el) => el.getAttribute("data-rule"));
    expect(keys).toEqual(["length", "lower", "upper", "number", "special"]);
  });

  it.each([
    ["Sh0rt!",            false, "under 8 characters"],
    ["nouppercase1!",     false, "no uppercase letter"],
    ["NOLOWERCASE1!",     false, "no lowercase letter"],
    ["NoDigitsHere!",     false, "no number"],
    ["NoSpecialChar1",    false, "no special character"],
    ["Replacement-2!",    true,  "meets every rule"],
  ])("check(%j) is %s — %s", (pw, expected) => {
    const h = load();
    document.body.innerHTML = h.mod.rulesHTML("checks");
    expect(h.mod.check(pw as string, "checks")).toBe(expected);
  });

  it("only calls the confirm field a match when it is non-empty and equal", () => {
    const h = load();
    document.body.innerHTML = h.mod.matchHTML("match");
    expect(h.mod.checkMatch("", "", "match")).toBe(false);
    expect(h.mod.checkMatch("Abcdef1!", "Abcdef1", "match")).toBe(false);
    expect(h.mod.checkMatch("Abcdef1!", "Abcdef1!", "match")).toBe(true);
  });
});

describe("the checklist against a live policy", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  /** Let the module's policy fetch and its repaint drain. */
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it("repaints a checklist rendered before the policy arrived", async () => {
    const h = load({
      policy: {
        policy: { minLength: 20, requireLowercase: true, requireUppercase: false, requireNumber: false, requireSpecial: false },
        rules: [{ key: "length", label: "At least 20 characters" }, { key: "lower", label: "Lowercase letter" }],
      },
    });
    document.body.innerHTML = h.mod.rulesHTML("checks");
    // Drawn from the shipped defaults first — a blank list would be worse.
    expect(document.querySelectorAll("#checks [data-rule]").length).toBe(5);

    await settle();
    const keys = Array.from(document.querySelectorAll("#checks [data-rule]")).map((el) => el.getAttribute("data-rule"));
    expect(keys).toEqual(["length", "lower"]);
    expect(document.querySelector('#checks [data-rule="length"]')!.textContent).toContain("At least 20 characters");
  });

  it("enforces the live minimum length in check()", async () => {
    const h = load({
      policy: {
        policy: { minLength: 20, requireLowercase: true, requireUppercase: true, requireNumber: true, requireSpecial: true },
      },
    });
    document.body.innerHTML = h.mod.rulesHTML("checks");
    await settle();
    // Fine under the defaults, ten characters short of this install's bar.
    expect(h.mod.check("Replacement-2!", "checks")).toBe(false);
    expect(h.mod.check("Replacement-2!-and-more", "checks")).toBe(true);
  });

  it("accepts what a RELAXED policy accepts", async () => {
    const h = load({
      policy: {
        policy: { minLength: 8, requireLowercase: true, requireUppercase: false, requireNumber: false, requireSpecial: false },
      },
    });
    document.body.innerHTML = h.mod.rulesHTML("checks");
    await settle();
    expect(h.mod.check("correcthorse", "checks")).toBe(true);
  });

  it("keeps the shipped defaults when the policy cannot be fetched", async () => {
    // Failing to the strictest thing the product ships with: the worst case is
    // a checklist asking for slightly more than the server will, never less.
    const h = load({ policy: null });
    document.body.innerHTML = h.mod.rulesHTML("checks");
    await settle();
    const keys = Array.from(document.querySelectorAll("#checks [data-rule]")).map((el) => el.getAttribute("data-rule"));
    expect(keys).toEqual(["length", "lower", "upper", "number", "special"]);
    expect(h.mod.check("Replacement-2!", "checks")).toBe(true);
  });

  it("fetches the policy once however many checklists are rendered", async () => {
    const h = load({ policy: { policy: { minLength: 8, requireLowercase: true, requireUppercase: true, requireNumber: true, requireSpecial: true } } });
    document.body.innerHTML = h.mod.rulesHTML("a") + h.mod.rulesHTML("b") + h.mod.rulesHTML("c");
    await settle();
    expect((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });
});

describe("PolarisPasswordSelf.open", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("opens with both new-password fields and the current-password field", () => {
    const h = load();
    h.mod.open({ username: "test_appdev" });
    expect(h.modals[0].title).toBe("Change Password");
    expect(document.getElementById("f-pw-current")).toBeTruthy();
    expect(document.getElementById("f-pw-new")).toBeTruthy();
    expect(document.getElementById("f-pw-new-confirm")).toBeTruthy();
    // The user should learn BEFORE submitting that this signs their other
    // browsers out — it is the surprising half of the action.
    expect(h.modals[0].body).toMatch(/signed out/i);
  });

  it.each([
    [{ current: "",             next: "Replacement-2!", confirm: "Replacement-2!" }, /current password/i],
    [{ current: "Original-1!",  next: "weak",           confirm: "weak"           }, /complexity/i],
    [{ current: "Original-1!",  next: "Replacement-2!", confirm: "Different-3!"   }, /do not match/i],
    [{ current: "Original-1!",  next: "Original-1!",    confirm: "Original-1!"    }, /different/i],
  ])("refuses to send %j", async (fields, expected) => {
    const h = load();
    h.mod.open({});
    await submit(fields);
    expect(h.sent).toHaveLength(0);
    expect(h.toasts[0].kind).toBe("error");
    expect(h.toasts[0].msg).toMatch(expected);
  });

  it("sends both fields, closes, and reports the sessions it signed out", async () => {
    const h = load({ revoked: 2 });
    h.mod.open({ onChange: h.onChange });
    await submit({ current: "Original-1!", next: "Replacement-2!", confirm: "Replacement-2!" });

    expect(h.sent).toEqual([{ currentPassword: "Original-1!", newPassword: "Replacement-2!" }]);
    expect(document.body.innerHTML).toBe("");
    expect(h.toasts[0].msg).toContain("2 other sessions");
  });

  it("says nothing about other sessions when there were none", async () => {
    const h = load({ revoked: 0 });
    h.mod.open({});
    await submit({ current: "Original-1!", next: "Replacement-2!", confirm: "Replacement-2!" });
    expect(h.toasts[0].msg).toBe("Password changed");
  });

  it("keeps the dialog open and the button live when the server refuses", async () => {
    const h = load({ changeError: "Current password is incorrect." });
    h.mod.open({});
    const btn = await submit({ current: "wrong", next: "Replacement-2!", confirm: "Replacement-2!" });

    expect(h.sent).toHaveLength(1);
    expect(h.toasts[0]).toEqual({ msg: "Current password is incorrect.", kind: "error" });
    expect(btn.disabled).toBe(false);
    expect(document.getElementById("f-pw-current")).toBeTruthy();
  });
});
