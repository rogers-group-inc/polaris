/**
 * tests/unit/shareLink.test.ts — public/js/share-link.js, the slide-overs' and
 * phone sheets' Share button.
 *
 * What is pinned: the link is the surface-neutral landing path on the sharer's
 * own origin (never a desktop- or phone-only URL); the phone prefers the system
 * share sheet and treats a dismissed sheet as nothing to report; every other
 * path copies, falling back from the async Clipboard API (secure contexts only —
 * Polaris supports plain HTTP) to execCommand, then to a prompt; the message
 * goes to the phone's snackbar on mobile.html and the toast elsewhere.
 *
 * The file is a browser IIFE, so it is evaluated in a vm context with stubs.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

const SRC = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../public/js/share-link.js"),
  "utf8",
);
const ID = "3f2a9c1e-7b4d-4e8a-9f01-2c3d4e5f6a7b";

interface Opts {
  secure?: boolean;
  clipboardRejects?: boolean;
  execCopyOk?: boolean;
  share?: (data: unknown) => Promise<void>;
  snackbar?: boolean;
}

function load(o: Opts = {}) {
  const calls = { clipboard: [] as string[], exec: 0, prompt: [] as string[], toast: [] as string[], snack: [] as string[], share: [] as unknown[] };
  const navigator: Record<string, unknown> = {
    clipboard: {
      writeText: (t: string) => {
        calls.clipboard.push(t);
        return o.clipboardRejects ? Promise.reject(new Error("denied")) : Promise.resolve();
      },
    },
  };
  if (o.share) {
    navigator.share = (d: unknown) => { calls.share.push(d); return o.share!(d); };
  }
  const body = { appendChild: () => {}, removeChild: () => {} };
  const document = {
    body,
    createElement: () => ({ style: {}, setAttribute: () => {}, select: () => {} }),
    execCommand: () => { calls.exec++; return o.execCopyOk !== false; },
  };
  const window: Record<string, unknown> = {
    location: { origin: "https://polaris.example" },
    isSecureContext: o.secure !== false,
    showToast: (m: string) => { calls.toast.push(m); },
    prompt: (_m: string, v: string) => { calls.prompt.push(v); },
  };
  if (o.snackbar) window.PolarisTabs = { showSnackbar: (m: string) => { calls.snack.push(m); } };
  const ctx = vm.createContext({ window, navigator, document, Promise });
  vm.runInContext(SRC, ctx);
  const api = window.PolarisShare as {
    url: (k: string, id: string) => string | null;
    share: (k: string, id: string, opts?: Record<string, unknown>) => Promise<string | null>;
  };
  return { api, calls };
}

describe("PolarisShare.url", () => {
  it("is the surface-neutral landing path on the sharer's origin", () => {
    const { api } = load();
    expect(api.url("asset", ID)).toBe(`https://polaris.example/assets/${ID}`);
    expect(api.url("network", ID)).toBe(`https://polaris.example/networks/${ID}`);
    expect(api.url("block", ID)).toBe(`https://polaris.example/blocks/${ID}`);
  });

  it("encodes the id and refuses an unknown kind or a missing id", () => {
    const { api } = load();
    expect(api.url("asset", "a/b")).toBe("https://polaris.example/assets/a%2Fb");
    expect(api.url("reservation", ID)).toBeNull();
    expect(api.url("asset", "")).toBeNull();
  });
});

describe("PolarisShare.share", () => {
  it("desktop: copies through the Clipboard API and toasts", async () => {
    const { api, calls } = load({ share: () => Promise.resolve() });
    expect(await api.share("asset", ID, { title: "core-sw-01" })).toBe("copied");
    expect(calls.clipboard).toEqual([`https://polaris.example/assets/${ID}`]);
    // native not asked for → the system sheet is not used even when present
    expect(calls.share).toHaveLength(0);
    expect(calls.toast[0]).toMatch(/Link copied/);
  });

  it("phone: opens the system share sheet with the title and link", async () => {
    const { api, calls } = load({ share: () => Promise.resolve(), snackbar: true });
    expect(await api.share("network", ID, { native: true, title: "10.1.0.0/24" })).toBe("shared");
    expect(calls.share).toEqual([{ title: "10.1.0.0/24", url: `https://polaris.example/networks/${ID}` }]);
    expect(calls.clipboard).toHaveLength(0);
  });

  it("phone: a dismissed sheet is not an error and copies nothing", async () => {
    const abort = Object.assign(new Error("cancel"), { name: "AbortError" });
    const { api, calls } = load({ share: () => Promise.reject(abort), snackbar: true });
    expect(await api.share("asset", ID, { native: true })).toBe("cancelled");
    expect(calls.clipboard).toHaveLength(0);
    expect(calls.snack).toHaveLength(0);
  });

  it("phone without a share sheet: copies and reports on the snackbar, not the toast", async () => {
    const { api, calls } = load({ snackbar: true });
    expect(await api.share("asset", ID, { native: true })).toBe("copied");
    expect(calls.snack[0]).toMatch(/Link copied/);
    expect(calls.toast).toHaveLength(0);
  });

  it("plain HTTP: skips the Clipboard API (secure contexts only) for execCommand", async () => {
    const { api, calls } = load({ secure: false });
    expect(await api.share("block", ID)).toBe("copied");
    expect(calls.clipboard).toHaveLength(0);
    expect(calls.exec).toBe(1);
  });

  it("a refused clipboard falls back to execCommand, then to a prompt holding the link", async () => {
    const { api, calls } = load({ clipboardRejects: true, execCopyOk: false });
    expect(await api.share("asset", ID)).toBe("shown");
    expect(calls.exec).toBe(1);
    expect(calls.prompt).toEqual([`https://polaris.example/assets/${ID}`]);
    expect(calls.toast).toHaveLength(0);
  });
});
