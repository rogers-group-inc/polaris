/**
 * tests/unit/_dbStub.ts — the shared stand-in for src/db.ts (CQ-T009).
 *
 * Before this, ~340 unit files hand-rolled `vi.mock("../../src/db.js", () =>
 * ({ prisma: { asset: { findUnique: … }, … } }))` and a `vi.hoisted` bag of
 * spies to go with it — and every new model a service touched meant editing
 * that literal or getting "prisma.x is undefined". Here every
 * `prisma.<model>.<method>` (and every `prisma.$raw`-style root method) is a
 * `vi.fn()` created on first touch and STABLE thereafter, so a test only
 * declares the calls it cares about:
 *
 *   vi.mock("../../src/db.js", () => import("./_dbStub.js"));
 *   import { prisma } from "../../src/db.js";          // the stub, typed as the real client
 *   import { resetDbStub } from "./_dbStub.js";
 *   beforeEach(() => resetDbStub());
 *   vi.mocked(prisma.asset.findUnique).mockResolvedValue({ id: "a" } as never);
 *   expect(prisma.asset.update).toHaveBeenCalledWith(...);
 *
 * Unconfigured methods resolve to undefined (a `vi.fn()` default), so a test
 * fails on its own assertions rather than on a TypeError deep in the service.
 * `$transaction` runs what it is given: an array of promises is awaited in
 * order, a callback gets the stub as its transaction client. `resetDbStub()`
 * resets every spy and restores that default.
 *
 * Models exist only once touched, so `Object.keys(prisma)` (or a for…in over a
 * model) is EMPTY — a test that sets defaults by iterating the client sets
 * none. Name the models: `for (const m of ["assetMonitorSample", …])
 * stubbed((prisma as any)[m].findMany).mockResolvedValue([])`.
 */

import { vi, type Mock } from "vitest";

type Fn = Mock<(...args: any[]) => any>;

const spies = new Map<string, Fn>();
const models = new Map<string, Record<string, Fn>>();

function spy(key: string): Fn {
  let f = spies.get(key);
  if (!f) {
    f = vi.fn();
    spies.set(key, f);
  }
  return f;
}

function modelProxy(name: string): Record<string, Fn> {
  let m = models.get(name);
  if (!m) {
    m = new Proxy({} as Record<string, Fn>, {
      get(_t, method) {
        if (typeof method !== "string" || method === "then") return undefined;
        return spy(`${name}.${method}`);
      },
    });
    models.set(name, m);
  }
  return m;
}

function applyDefaults(): void {
  spy("$transaction").mockImplementation(async (arg: unknown) => {
    if (Array.isArray(arg)) {
      const out: unknown[] = [];
      for (const p of arg) out.push(await p);
      return out;
    }
    if (typeof arg === "function") return (arg as (tx: unknown) => unknown)(stub);
    return undefined;
  });
}

const stub: any = new Proxy({}, {
  get(_t, key) {
    // `then` must stay undefined or `await prisma` would treat the stub as a thenable.
    if (typeof key !== "string" || key === "then") return undefined;
    if (key.startsWith("$")) return spy(key);
    return modelProxy(key);
  },
});

applyDefaults();

/** The stubbed client. Import it through `../../src/db.js` to get the real client's types. */
export const prisma = stub;
export const prismaBase = stub;

/**
 * A stub method as a loosely typed spy, so a test can resolve a PARTIAL row
 * without fighting Prisma's generated types: `stubbed(prisma.asset.findUnique)
 * .mockResolvedValue({ id: "a" })`. (`vi.mocked(...)` keeps the real types.)
 */
export function stubbed(fn: unknown): Fn {
  return fn as Fn;
}

/** Reset every spy (calls + implementations) and restore the `$transaction` default. */
export function resetDbStub(): void {
  for (const f of spies.values()) f.mockReset();
  applyDefaults();
}
