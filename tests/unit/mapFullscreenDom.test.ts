/**
 * tests/unit/mapFullscreenDom.test.ts — the Device Map's and Application Map's
 * on-map Full screen button (public/js/map-fullscreen.js).
 *
 * Full screen is requested on the document root and the map is pinned over
 * the page by a class, so slide-overs and modals the map opens still stack on
 * top of it. What breaks silently: the class outliving native full screen (the
 * map stays pinned over a page that is no longer full screen), Esc in the
 * CSS-only fallback stealing the key from a modal open over the map, and the
 * map never being told its container changed size.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const g = globalThis as Record<string, any>;
const src = readFileSync(resolve(__dirname, "../../public/js/map-fullscreen.js"), "utf8");
// eslint-disable-next-line no-new-func
new Function(src)();
const FS = g.window.PolarisMapFullscreen;

function flushRaf() {
  return new Promise((r) => setTimeout(r, 30));
}

describe("PolarisMapFullscreen", () => {
  let btn: HTMLButtonElement;
  let target: HTMLElement;
  let onResize: ReturnType<typeof vi.fn>;
  let nativeEl: Element | null;

  beforeEach(() => {
    document.body.innerHTML = '<div id="map"></div><button id="fs"></button>';
    btn = document.getElementById("fs") as HTMLButtonElement;
    target = document.getElementById("map") as HTMLElement;
    onResize = vi.fn();
    nativeEl = null;
    Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => nativeEl });
    (document.documentElement as any).requestFullscreen = vi.fn(() => { nativeEl = document.documentElement; return Promise.resolve(); });
    (document as any).exitFullscreen = vi.fn(() => { nativeEl = null; return Promise.resolve(); });
  });

  it("requests full screen on the document root, not the map, and pins the map with the class", async () => {
    FS.attach(btn, target, onResize);
    expect(btn.getAttribute("aria-label")).toBe("Full screen");
    btn.click();
    expect(target.classList.contains("map-fullscreen")).toBe(true);
    expect((document.documentElement as any).requestFullscreen).toHaveBeenCalledTimes(1);
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    expect(btn.getAttribute("aria-label")).toBe("Exit full screen");
    await flushRaf();
    expect(onResize).toHaveBeenCalled();
  });

  it("a second click leaves full screen and unpins", () => {
    FS.attach(btn, target, onResize);
    btn.click();
    btn.click();
    expect(target.classList.contains("map-fullscreen")).toBe(false);
    expect((document as any).exitFullscreen).toHaveBeenCalledTimes(1);
  });

  it("drops the class when the browser leaves native full screen on its own (Esc, F11)", async () => {
    FS.attach(btn, target, onResize);
    btn.click();
    onResize.mockClear();
    nativeEl = null;
    document.dispatchEvent(new Event("fullscreenchange"));
    expect(target.classList.contains("map-fullscreen")).toBe(false);
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    await flushRaf();
    expect(onResize).toHaveBeenCalled();
  });

  it("CSS-only fallback: Esc leaves, unless a modal or slide-over is open on top", () => {
    delete (document.documentElement as any).requestFullscreen;
    FS.attach(btn, target, onResize);
    btn.click();
    expect(target.classList.contains("map-fullscreen")).toBe(true);
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay open";
    document.body.appendChild(overlay);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(target.classList.contains("map-fullscreen")).toBe(true);
    overlay.remove();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(target.classList.contains("map-fullscreen")).toBe(false);
  });
});
