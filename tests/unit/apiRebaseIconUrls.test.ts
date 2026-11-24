/**
 * tests/unit/apiRebaseIconUrls.test.ts
 *
 * public/js/api.js → _rebaseIconUrls(): the server writes a custom device
 * icon into a topology as `iconUrl: "/api/v1/device-icons/<id>/image"`. On the
 * /dash wallboard (window.__polarisApiBase = "/dash/api/v1") that path asks
 * the signed-in API, which the wallboard has no session for, so custom icons
 * drew blank (operator report 2026-11-24). api.map.topology() re-roots every
 * iconUrl under the page's API base; off /dash it changes nothing.
 *
 * api.js is a classic script: evaluated in a vm context, as in
 * apiResponseParse.test.ts.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";

type Rebase = (node: unknown) => unknown;

function loadRebase(apiBase: string | undefined): Rebase {
  const src = readFileSync(resolve(__dirname, "../../public/js/api.js"), "utf8");
  const sandbox: Record<string, unknown> = {
    window: apiBase ? { __polarisApiBase: apiBase } : {},
    document: { getElementById: () => null, createElement: () => ({ style: {}, addEventListener: () => {} }) },
    navigator: {},
    fetch: () => Promise.reject(new Error("unused")),
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    setTimeout,
    clearTimeout,
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: "api.js" });
  return sandbox._rebaseIconUrls as Rebase;
}

const topology = () => ({
  fortigate: { id: "fg", iconUrl: "/api/v1/device-icons/aaa/image" },
  switches: [
    { id: "s1", iconUrl: "/api/v1/device-icons/bbb/image" },
    { id: "s2", iconUrl: null },
    { id: "s3", iconUrl: "/img/builtin/switch.svg" },
  ],
  nested: { deeper: [{ iconUrl: "/api/v1/device-icons/ccc/image", note: "/api/v1/not-an-icon" }] },
});

describe("_rebaseIconUrls", () => {
  it("re-roots every custom icon under the wallboard's API base", () => {
    const out = loadRebase("/dash/api/v1")(topology()) as ReturnType<typeof topology>;
    expect(out.fortigate.iconUrl).toBe("/dash/api/v1/device-icons/aaa/image");
    expect(out.switches[0]!.iconUrl).toBe("/dash/api/v1/device-icons/bbb/image");
    expect(out.nested.deeper[0]!.iconUrl).toBe("/dash/api/v1/device-icons/ccc/image");
  });

  it("leaves a missing icon, a built-in icon and other fields alone", () => {
    const out = loadRebase("/dash/api/v1")(topology()) as ReturnType<typeof topology>;
    expect(out.switches[1]!.iconUrl).toBeNull();
    expect(out.switches[2]!.iconUrl).toBe("/img/builtin/switch.svg");
    expect(out.nested.deeper[0]!.note).toBe("/api/v1/not-an-icon");
  });

  it("changes nothing on the signed-in app", () => {
    expect(loadRebase(undefined)(topology())).toEqual(topology());
  });

  it("passes a non-object through", () => {
    const rebase = loadRebase("/dash/api/v1");
    expect(rebase(null)).toBeNull();
    expect(rebase("x")).toBe("x");
  });
});
