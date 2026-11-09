/**
 * tests/unit/topologyEditSession.test.ts
 *
 * The Device Map topology's edit mode stages layout changes instead of
 * persisting them: a drag while editing reaches neither localStorage nor the
 * server until Done Editing (the tick) or Save commits the session, and
 * closing the map mid-edit discards it. Before this, every drag debounce-PUT
 * on its own and closing flushed it, so "close without the tick" saved anyway.
 *
 * The persistence block of public/js/map.js is evaluated in a vm with a stub
 * canvas, localStorage and api, so the real functions are what run.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";

const SRC = readFileSync(resolve(__dirname, "../../public/js/map.js"), "utf8").replace(/\r\n/g, "\n");

function slice(from: string, to: string): string {
  const a = SRC.indexOf(from);
  const b = SRC.indexOf(to, a);
  expect(a, `missing ${from}`).toBeGreaterThan(-1);
  expect(b, `missing ${to}`).toBeGreaterThan(a);
  return SRC.slice(a, b);
}

type Harness = {
  ctx: Record<string, any>;
  store: Map<string, string>;
  calls: { put: any[]; del: any[] };
  move: (x: number) => void;
};

function harness(opts: { writer?: boolean } = {}): Harness {
  const store = new Map<string, string>();
  const calls = { put: [] as any[], del: [] as any[] };
  let pos = { x: 0, y: 0 };
  const ctx: Record<string, any> = {
    POSITION_STORAGE_PREFIX: "polaris.topology.positions:",
    topoState: { siteId: "site-1", activeView: "flat", editing: false, data: { savedLayouts: {} } },
    cyInstance: {},
    edgeEditor: null,
    localStorage: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    },
    permAtLeast: () => opts.writer !== false,
    showToast: () => {},
    api: {
      map: {
        saveTopologyLayout: async (id: string, view: string, p: unknown) => { calls.put.push({ id, view, p }); },
        deleteTopologyLayout: async (id: string, view: string) => { calls.del.push({ id, view }); },
      },
    },
    setTimeout, clearTimeout, Promise, Object, JSON,
  };
  vm.createContext(ctx);
  vm.runInContext(
    "function _currentNodePositions() { return { 'sw-1': { x: __pos().x, y: __pos().y } }; }\n" +
    slice("  function _activeViewKey() {", "  // ── Topology search"),
    Object.assign(ctx, { __pos: () => pos }),
  );
  return {
    ctx, store, calls,
    // An operator drag: move the node, mark the view dirty, save (as the
    // canvas's `free` handler does).
    move(x: number) {
      pos = { x, y: 0 };
      ctx._markLayoutDirty();
      ctx.saveNodePositions("site-1");
    },
  };
}

const KEY = "polaris.topology.positions:site-1";

describe("topology edit session", () => {
  let h: Harness;
  beforeEach(() => { h = harness(); });

  it("outside edit mode a drag still persists (localStorage + debounced PUT)", async () => {
    h.move(10);
    expect(JSON.parse(h.store.get(KEY)!)).toEqual({ "sw-1": { x: 10, y: 0 } });
    await h.ctx._flushServerLayoutSaves();
    expect(h.calls.put).toHaveLength(1);
  });

  it("a drag while editing writes nothing, but the canvas reloads it", async () => {
    h.ctx.topoState.editing = true;
    h.ctx._beginEditSession();
    h.move(42);
    await h.ctx._flushServerLayoutSaves();
    expect(h.store.has(KEY)).toBe(false);
    expect(h.calls.put).toHaveLength(0);
    // A view switch / Refresh mid-edit re-renders from the staged layout.
    expect(h.ctx.loadNodePositions("site-1")).toEqual({ "sw-1": { x: 42, y: 0 } });
  });

  it("discarding (closing mid-edit) drops the change everywhere", async () => {
    h.ctx.topoState.editing = true;
    h.ctx._beginEditSession();
    h.move(42);
    expect(h.ctx._discardEditSession()).toBe(true);
    await h.ctx._flushServerLayoutSaves();
    expect(h.store.has(KEY)).toBe(false);
    expect(h.calls.put).toHaveLength(0);
    h.ctx.topoState.editing = false;
    expect(h.ctx.loadNodePositions("site-1")).toBeNull();
  });

  it("an untouched session reports nothing to discard", () => {
    h.ctx.topoState.editing = true;
    h.ctx._beginEditSession();
    expect(h.ctx._discardEditSession()).toBe(false);
  });

  it("committing (Done Editing) lands the change in both stores", async () => {
    h.ctx.topoState.editing = true;
    h.ctx._beginEditSession();
    h.move(42);
    await h.ctx._commitEditSession();
    expect(JSON.parse(h.store.get(KEY)!)).toEqual({ "sw-1": { x: 42, y: 0 } });
    expect(h.calls.put).toEqual([{ id: "site-1", view: "flat", p: { "sw-1": { x: 42, y: 0 } } }]);
  });

  it("commit also catches a drag whose debounced save has not run yet", async () => {
    h.ctx.topoState.editing = true;
    h.ctx._beginEditSession();
    h.ctx._markLayoutDirty(); // the drag ended; its 250 ms save is pending
    await h.ctx._commitEditSession();
    expect(h.calls.put).toHaveLength(1);
  });

  it("a staged baseline load commits as the DELETE, and a refresh capture keeps it", async () => {
    h.store.set(KEY, JSON.stringify({ "sw-1": { x: 5, y: 5 } }));
    h.ctx.topoState.editing = true;
    h.ctx._beginEditSession();
    h.ctx._stageLayout("flat", {}, { reset: true, deleteServer: true });
    h.ctx.saveNodePositions("site-1"); // a view switch / Refresh capture: not dirty
    expect(h.ctx.loadNodePositions("site-1")).toEqual({});
    await h.ctx._commitEditSession();
    expect(h.store.has(KEY)).toBe(false);
    expect(h.calls.del).toEqual([{ id: "site-1", view: "flat" }]);
    expect(h.calls.put).toHaveLength(0);
  });

  it("a non-writer's commit lands locally only", async () => {
    h = harness({ writer: false });
    h.ctx.topoState.editing = true;
    h.ctx._beginEditSession();
    h.move(7);
    await h.ctx._commitEditSession();
    expect(JSON.parse(h.store.get(KEY)!)).toEqual({ "sw-1": { x: 7, y: 0 } });
    expect(h.calls.put).toHaveLength(0);
  });
});

describe("the edit session's wiring in map.js", () => {
  const fn = (name: string) => {
    const s = SRC.slice(SRC.indexOf("function " + name + "("));
    return s.slice(0, s.indexOf("\n  }\n"));
  };

  it("closing the map mid-edit discards, and does not save", () => {
    const close = fn("closeTopology");
    expect(close).toMatch(/if \(topoState\.editing\) \{\s*if \(_discardEditSession\(\)/);
  });

  it("Done Editing commits; entering edit mode begins a session", () => {
    const set = fn("_setTopologyEditing");
    expect(set).toContain("_beginEditSession()");
    expect(set).toContain("_commitEditSession()");
  });

  it("Save commits the session before stamping the restore point", () => {
    const save = fn("saveTopologyLayoutCheckpoint");
    expect(save.indexOf("_commitEditSession()")).toBeGreaterThan(-1);
    expect(save.indexOf("_commitEditSession()")).toBeLessThan(save.indexOf("saveTopologyCheckpoint("));
  });
});
