/**
 * tests/unit/mobileLoginKeyboardFit.test.ts
 *
 * The mobile login screen's on-screen-keyboard fit. On iOS the layout viewport
 * doesn't shrink for the keyboard, and the mobile shell gives the operator no
 * way out of that on their own: body is overflow:hidden and .login-shell is
 * exactly min-height:100%, so .app-body has nothing to scroll and the password
 * field / Sign in button are unreachable behind the keyboard.
 *
 * Three things have to hold. The delta threshold must tell a keyboard from a
 * collapsing URL bar (a false positive re-pins the layout for no reason, and
 * Android — where the layout viewport DOES shrink — must be left alone). The
 * class must come off once the auth screens are gone, since they're replaced
 * wholesale with no teardown hook and a stuck kb-open would size the
 * authenticated shell to a stale height. And the scroll-into-view must fire
 * once per form, not on every viewport event, or it fights the user's scroll.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(process.cwd(), "public", "js", "mobile", "auth.js"), "utf-8");

const g = globalThis as any;

const LAYOUT_H = 800;

type Vv = {
  height: number;
  offsetTop: number;
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(): void;
  emit(type: string): void;
};

function makeVisualViewport(height: number): Vv {
  const listeners: Record<string, Array<() => void>> = {};
  return {
    height,
    offsetTop: 0,
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    removeEventListener() { /* the module never detaches */ },
    emit(type) { (listeners[type] || []).forEach((fn) => fn()); },
  };
}

let rafQueue: Array<() => void> = [];
function flushRaf() {
  const queued = rafQueue;
  rafQueue = [];
  queued.forEach((fn) => fn());
}

/** Open the keyboard to `visibleH` and let the rAF-coalesced handler run. */
function keyboardTo(vv: Vv, visibleH: number, offsetTop = 0) {
  vv.height = visibleH;
  vv.offsetTop = offsetTop;
  vv.emit("resize");
  flushRaf();
}

const appEl = () => document.getElementById("app") as HTMLElement;
const pinned = () => appEl().classList.contains("kb-open");

// One module instance and one visualViewport for the whole file — the same
// shape as a real page load, and the only isolation that works here: the
// module attaches a document-level focusin listener that no teardown hook
// removes, so re-evaluating the source per test would leave every earlier
// instance reacting to the same DOM.
let vv: Vv;

async function renderLogin() {
  document.body.innerHTML = '<div class="app" id="app"></div>';
  g.PolarisAuth.renderLogin(appEl());
  // Let the branding / SSO promise chains settle so they can't repaint mid-test.
  await new Promise((r) => setTimeout(r, 0));
  flushRaf();   // drop the focusin schedule renderLogin's autofocus may have queued
  return vv;
}

beforeAll(() => {
  vv = makeVisualViewport(LAYOUT_H);
  g.visualViewport = vv;
  g.requestAnimationFrame = (fn: () => void) => { rafQueue.push(fn); return rafQueue.length; };
  g.PolarisAuthFlow = {
    fetchBranding: vi.fn(async () => null),
    fetchAzureConfig: vi.fn(async () => ({ enabled: false })),
    login: vi.fn(),
    confirmTotp: vi.fn(),
  };
  g.PolarisMobile = { boot: vi.fn() };
  new Function(SRC)();
});

beforeEach(() => {
  rafQueue = [];
  vv.height = LAYOUT_H;
  vv.offsetTop = 0;
  Object.defineProperty(window, "innerHeight", { value: LAYOUT_H, configurable: true, writable: true });
  Object.defineProperty(document.documentElement, "clientHeight", { value: LAYOUT_H, configurable: true });
});

describe("mobile login keyboard fit", () => {
  it("pins .app to the visible rect when the keyboard opens", async () => {
    const vv = await renderLogin();
    expect(pinned()).toBe(false);

    keyboardTo(vv, 380, 12);

    expect(pinned()).toBe(true);
    expect(appEl().style.getPropertyValue("--vv-height")).toBe("380px");
    expect(appEl().style.getPropertyValue("--vv-offset-top")).toBe("12px");
  });

  it("ignores a shrink too small to be a keyboard (collapsing browser chrome)", async () => {
    const vv = await renderLogin();

    keyboardTo(vv, LAYOUT_H - 60);

    expect(pinned()).toBe(false);
  });

  it("leaves Android alone — a layout viewport that shrinks with the keyboard shows no gap", async () => {
    const vv = await renderLogin();

    // Chrome resizes the layout viewport too, so both measurements move together.
    Object.defineProperty(window, "innerHeight", { value: 380, configurable: true, writable: true });
    Object.defineProperty(document.documentElement, "clientHeight", { value: 380, configurable: true });
    keyboardTo(vv, 380);

    expect(pinned()).toBe(false);
  });

  it("unpins when the keyboard closes", async () => {
    const vv = await renderLogin();
    keyboardTo(vv, 380);
    expect(pinned()).toBe(true);

    keyboardTo(vv, LAYOUT_H);

    expect(pinned()).toBe(false);
    expect(appEl().style.getPropertyValue("--vv-height")).toBe("");
    expect(appEl().style.getPropertyValue("--vv-offset-top")).toBe("");
  });

  it("unpins once the auth screens are gone, even with the keyboard still up", async () => {
    const vv = await renderLogin();
    keyboardTo(vv, 380);
    expect(pinned()).toBe(true);

    // What boot() does on a successful sign-in: the login form is replaced by
    // the authenticated shell, which sizes itself off height:100%.
    appEl().innerHTML = '<main class="app-body" id="app-body"></main>';
    keyboardTo(vv, 360);

    expect(pinned()).toBe(false);
  });

  it("scrolls the form's submit button into view once per form, not per event", async () => {
    const vv = await renderLogin();
    const form = document.getElementById("login-form") as HTMLFormElement;
    const password = document.getElementById("password") as HTMLInputElement;
    const scrollIntoView = vi.fn();
    (form as any).scrollIntoView = scrollIntoView;
    (password as any).scrollIntoView = scrollIntoView;
    password.focus();

    keyboardTo(vv, 380);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.calls[0][0]).toMatchObject({ block: "end" });

    // Subsequent viewport events (the operator scrolling, iOS settling) must
    // not yank the view back.
    keyboardTo(vv, 378);
    vv.emit("scroll");
    flushRaf();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });
});
