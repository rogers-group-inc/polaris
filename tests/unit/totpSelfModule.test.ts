/**
 * tests/unit/totpSelfModule.test.ts — the shared self-service TOTP module
 * (public/js/totp-self.js).
 *
 * The flow moved out of users.js so the account menu on every page can reach
 * it. What's pinned here is the routing `open()` does off the status payload:
 * an enabled account can only disable, a fresh one enrolls, and a non-local
 * account is refused CLIENT-side too — the enroll route rejects it, so
 * opening a QR-code modal that can never be confirmed would be worse than
 * saying why.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(process.cwd(), "public", "js", "totp-self.js"), "utf-8");

interface Harness {
  modals: { title: string; body: string; footer: string }[];
  toasts: { msg: string; kind?: string }[];
  posts: string[];
}

function load(opts: {
  status?: Record<string, unknown>;
  statusError?: string;
  enrollError?: string;
}): Harness & { mod: Record<string, (o?: unknown) => Promise<void> | void> } {
  const h: Harness = { modals: [], toasts: [], posts: [] };
  const g = globalThis as Record<string, unknown>;

  g.api = {
    totp: {
      status: vi.fn(async () => {
        h.posts.push("status");
        if (opts.statusError) throw new Error(opts.statusError);
        return opts.status ?? { authProvider: "local", enabled: false, enrolling: false };
      }),
      enroll: vi.fn(async () => {
        h.posts.push("enroll");
        if (opts.enrollError) throw new Error(opts.enrollError);
        return { secret: "ABCD2345", otpauthUri: "otpauth://x", qrSvg: "<svg id='qr'/>" };
      }),
      confirm: vi.fn(async () => { h.posts.push("confirm"); return { ok: true, backupCodes: ["AAAA-BBBB"] }; }),
      disable: vi.fn(async () => { h.posts.push("disable"); return { ok: true }; }),
    },
  };
  g.escapeHtml = (s: string) => String(s);
  g.copyTextToClipboard = async () => true;
  g.showToast = (msg: string, kind?: string) => { h.toasts.push({ msg, kind }); };
  g.val = (id: string) => (document.getElementById(id) as HTMLInputElement).value.trim();
  g.currentUsername = "test_appdev";
  g.openModal = (title: string, body: string, footer: string) => {
    h.modals.push({ title, body, footer });
    document.body.innerHTML = '<div id="modal">' + body + footer + "</div>";
  };
  g.closeModal = () => { document.body.innerHTML = ""; };

  new Function(SRC)();
  const mod = (globalThis as Record<string, unknown>).PolarisTotpSelf as Record<string, (o?: unknown) => Promise<void> | void>;
  return { ...h, mod };
}

describe("PolarisTotpSelf.open", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("enrolls an account that hasn't set 2FA up", async () => {
    const h = load({ status: { authProvider: "local", enabled: false, enrolling: false } });
    await h.mod.open();
    expect(h.posts).toEqual(["status", "enroll"]);
    expect(h.modals[0].title).toBe("Enable Two-Factor Auth");
    // The manual-entry fallback matters when a phone camera can't reach the screen.
    expect(h.modals[0].body).toContain("ABCD2345");
  });

  it("takes an enabled account to the disable flow instead", async () => {
    const h = load({ status: { authProvider: "local", enabled: true, enrolling: false } });
    await h.mod.open();
    expect(h.posts).toEqual(["status"]);
    expect(h.modals[0].title).toBe("Disable Two-Factor Auth");
    expect(h.modals[0].body).toContain("test_appdev");
  });

  it("refuses an SSO account with the reason rather than an unusable QR code", async () => {
    const h = load({ status: { authProvider: "azure", enabled: false, enrolling: false } });
    await h.mod.open();
    expect(h.posts).toEqual(["status"]);
    expect(h.modals).toHaveLength(0);
    expect(h.toasts[0].msg).toContain("identity provider");
  });

  it("surfaces a status failure without opening anything", async () => {
    const h = load({ statusError: "boom" });
    await h.mod.open();
    expect(h.modals).toHaveLength(0);
    expect(h.toasts[0]).toEqual({ msg: "boom", kind: "error" });
  });

  it("refuses to POST a code that isn't six digits", async () => {
    const h = load({});
    await h.mod.openEnroll();
    (document.getElementById("f-totp-code") as HTMLInputElement).value = "123";
    (document.getElementById("btn-totp-confirm") as HTMLButtonElement).click();
    await Promise.resolve();
    expect(h.posts).toEqual(["enroll"]);
    expect(h.toasts[0].kind).toBe("error");
  });

  it("shows the backup codes once enrollment confirms, and tells the caller state changed", async () => {
    const h = load({});
    const changed: number[] = [];
    await h.mod.openEnroll({ onChange: () => changed.push(1) });
    (document.getElementById("f-totp-code") as HTMLInputElement).value = "123456";
    (document.getElementById("btn-totp-confirm") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.posts).toEqual(["enroll", "confirm"]);
    expect(h.modals[h.modals.length - 1].title).toBe("Backup Codes");
    expect(h.modals[h.modals.length - 1].body).toContain("AAAA-BBBB");
    expect(changed).toEqual([1]);
  });

  it("passes the backup-code checkbox through so a lost device is recoverable", async () => {
    const h = load({});
    await h.mod.openDisable();
    (document.getElementById("f-totp-disable-code") as HTMLInputElement).value = "AAAA-BBBB";
    (document.getElementById("f-totp-backup-check") as HTMLInputElement).checked = true;
    (document.getElementById("btn-totp-disable") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    const api = (globalThis as unknown as Record<string, { totp: { disable: ReturnType<typeof vi.fn> } }>).api;
    expect(api.totp.disable).toHaveBeenCalledWith({ code: "AAAA-BBBB", isBackupCode: true });
  });
});
