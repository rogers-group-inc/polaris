/**
 * tests/unit/actionHeaderMask.test.ts
 *
 * Business rule 114(h): an api_call action's custom headers are secrets —
 * masked in every response, and preserve-on-echo on save only from a stored
 * action with the SAME url and header name (the rule-111 shape: a stored
 * token never follows an edited destination). rbacLeftovers.test.ts covers the
 * route wiring; this file pins the pure helpers.
 */

import { describe, it, expect } from "vitest";
import { maskActionHeaders, restoreMaskedActionHeaders } from "../../src/utils/actionHeaderMask.js";
import { SECRET_MASK } from "../../src/utils/secretMask.js";
import { AppError } from "../../src/utils/errors.js";

describe("maskActionHeaders", () => {
  it("masks every non-empty string header of an api_call action, nested anywhere", () => {
    const input = {
      name: "rule",
      actions: [
        { type: "api_call", url: "https://x.example/hook", headers: { Authorization: "Bearer abc", "X-Empty": "", "X-Num": 5 } },
        { type: "email", headers: { Authorization: "not an api call" } },
      ],
      nested: { deeper: [{ type: "api_call", url: "u", headers: { K: "v" } }] },
    };
    const out = maskActionHeaders(input);
    expect(out.actions[0].headers).toEqual({ Authorization: SECRET_MASK, "X-Empty": "", "X-Num": 5 });
    expect(out.actions[1].headers).toEqual({ Authorization: "not an api call" });
    expect(out.nested.deeper[0].headers).toEqual({ K: SECRET_MASK });
    expect(out.actions[0].url).toBe("https://x.example/hook");
  });

  it("returns a copy and never mutates the input", () => {
    const input = { type: "api_call", url: "u", headers: { K: "secret" } };
    const out = maskActionHeaders(input);
    expect(out).not.toBe(input);
    expect(input.headers.K).toBe("secret");
  });

  it("passes scalars, null and class instances through unchanged", () => {
    expect(maskActionHeaders(null)).toBeNull();
    expect(maskActionHeaders("x")).toBe("x");
    const d = new Date(0);
    expect(maskActionHeaders(d)).toBe(d);
  });

  it("leaves a non-object headers value on an api_call alone", () => {
    expect(maskActionHeaders({ type: "api_call", headers: "raw" })).toEqual({ type: "api_call", headers: "raw" });
  });
});

describe("restoreMaskedActionHeaders", () => {
  const stored = { actions: [{ type: "api_call", url: "https://a.example/x", headers: { Authorization: "Bearer real" } }] };

  it("restores a masked header from the stored action with the same url + name (name case-insensitive, url trimmed)", () => {
    const input = { actions: [{ type: "api_call", url: " https://a.example/x ", headers: { authorization: SECRET_MASK } }] };
    restoreMaskedActionHeaders(input, stored);
    expect(input.actions[0].headers.authorization).toBe("Bearer real");
  });

  it("leaves an edited (unmasked) header value as typed", () => {
    const input = { actions: [{ type: "api_call", url: "https://a.example/x", headers: { Authorization: "Bearer new" } }] };
    restoreMaskedActionHeaders(input, stored);
    expect(input.actions[0].headers.Authorization).toBe("Bearer new");
  });

  it("refuses a masked header whose url changed — the token does not follow the destination", () => {
    const input = { actions: [{ type: "api_call", url: "https://evil.example/x", headers: { Authorization: SECRET_MASK } }] };
    expect(() => restoreMaskedActionHeaders(input, stored)).toThrow(AppError);
    try {
      restoreMaskedActionHeaders(input, stored);
    } catch (e) {
      expect((e as AppError).httpStatus).toBe(400);
      expect((e as Error).message).toContain('"Authorization"');
      expect((e as Error).message).toContain("https://evil.example/x");
    }
  });

  it("refuses a masked header on a create (stored = null)", () => {
    const input = { type: "api_call", url: "u", headers: { K: SECRET_MASK } };
    expect(() => restoreMaskedActionHeaders(input, null)).toThrow(/left masked/);
  });

  it("never restores from a stored value that is itself the mask", () => {
    const badStored = { type: "api_call", url: "u", headers: { K: SECRET_MASK } };
    const input = { type: "api_call", url: "u", headers: { K: SECRET_MASK } };
    expect(() => restoreMaskedActionHeaders(input, badStored)).toThrow(AppError);
  });

  it("is a no-op when nothing is masked or there are no api_call actions", () => {
    const input = { actions: [{ type: "email", headers: { K: SECRET_MASK } }] };
    expect(() => restoreMaskedActionHeaders(input, null)).not.toThrow();
    expect(input.actions[0].headers.K).toBe(SECRET_MASK);
  });
});
