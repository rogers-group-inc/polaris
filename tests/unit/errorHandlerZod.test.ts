/**
 * tests/unit/errorHandlerZod.test.ts — the API's 400 body for a Zod failure.
 *
 * Pinned across the Zod 3 → 4 move (Dependabot #81, GHSA-mrhx-c7xc-m3w5):
 *   - the body is `{ error: "<path>: <message>; …" }` — one string, issues
 *     joined by "; ", each prefixed by its dotted path when it has one;
 *   - an operator-written message (`.min(1, "…")`, a superRefine's addIssue)
 *     reaches the body verbatim — Zod's DEFAULT wording changed in 4 and is
 *     not part of the contract, the custom messages are;
 *   - a failing array is still rejected under the 1 MB body cap without one
 *     issue per element blowing the heap (the advisory's case).
 */

import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import type { Request, Response, NextFunction } from "express";
import { errorHandler } from "../../src/api/middleware/errorHandler.js";

function run(err: unknown): { status: number; body: unknown } {
  const out = { status: 0, body: undefined as unknown };
  const res = {
    status(code: number) { out.status = code; return this; },
    json(b: unknown) { out.body = b; return this; },
  } as unknown as Response;
  errorHandler(err, {} as Request, res, vi.fn() as unknown as NextFunction);
  return out;
}

function zodError(schema: z.ZodType, input: unknown): z.ZodError {
  const r = schema.safeParse(input);
  if (r.success) throw new Error("expected a failure");
  return r.error;
}

describe("errorHandler — ZodError → 400", () => {
  it("joins issues as 'path: message' with '; ' and keeps custom messages verbatim", () => {
    const schema = z.object({
      name: z.string().min(1, "A widget needs a name"),
      nested: z.object({ path: z.string().min(1, "A widget needs a path") }),
    });
    const { status, body } = run(zodError(schema, { name: "", nested: { path: "" } }));
    expect(status).toBe(400);
    expect(body).toEqual({ error: "name: A widget needs a name; nested.path: A widget needs a path" });
  });

  it("an issue with no path is the bare message", () => {
    const schema = z.string().superRefine((_v, ctx) => {
      ctx.addIssue({ code: "custom", message: "Request body is not valid JSON" });
    });
    expect(run(zodError(schema, "x")).body).toEqual({ error: "Request body is not valid JSON" });
  });

  it("a uuid-ish id that v3 accepted is still accepted (guid, not RFC-strict uuid)", () => {
    const schema = z.object({ id: z.string().guid() });
    expect(schema.safeParse({ id: "00000000-0000-0000-0000-000000000001" }).success).toBe(true);
    expect(schema.safeParse({ id: "not-a-uuid" }).success).toBe(false);
  });

  it("an over-length array stops at the length check — one issue, not one per element", () => {
    // 500k failing elements is what a 1 MB JSON body ("[0,0,…]") can carry.
    // On zod 3.25.76 .max() did NOT short-circuit: every element was still
    // parsed and ~175 MB of issue objects accumulated. 4.6.6+ stops at the
    // length check — but ONLY when the array has a .max(); an uncapped array
    // still yields one issue per element, which is why every request array
    // schema carries one (tests/unit/zodArrayCaps.test.ts).
    const r = z.object({ ids: z.array(z.string()).max(1000) }).safeParse({ ids: new Array(500_000).fill(0) });
    expect(r.success).toBe(false);
    expect(r.error!.issues).toHaveLength(1);
  });
});
