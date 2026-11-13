/**
 * tests/unit/topologyCableRuns.test.ts
 *
 * The cable-run layer's pure helpers (public/js/topology-cable-runs.js,
 * business rule 184): the edit session sends exactly what changed — new runs
 * without an id, changed runs with theirs, untouched runs not at all, removed
 * runs as deletes — and the length the panel shows matches the server's.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

let C: Record<string, any>;

beforeAll(() => {
  const sb: Record<string, any> = { window: {}, console };
  vm.createContext(sb);
  vm.runInContext(readFileSync(resolve(__dirname, "../../public/js/topology-cable-runs.js"), "utf8"), sb);
  C = sb.window.PolarisTopologyCableRuns;
});

const run = (id: string, extra: Record<string, unknown> = {}) => ({
  id, name: id, medium: "fiber", placement: "electric_pole", notes: "", points: [[-85, 38], [-85, 38.001]], ...extra,
});

describe("diffRuns", () => {
  it("sends new, changed and removed runs, and nothing for an untouched one", () => {
    const loaded = [run("a"), run("b"), run("c")];
    const current = [
      run("a"),                                         // untouched
      run("b", { medium: "ethernet" }),                 // changed
      { name: "", medium: "fiber", placement: "telephone_pole", notes: "", points: [[-85, 38], [-85.001, 38]] }, // new
    ];
    const d = JSON.parse(JSON.stringify(C._diffRuns(loaded, current)));
    expect(d.deletes).toEqual(["c"]);
    expect(d.upserts).toHaveLength(2);
    expect(d.upserts[0]).toMatchObject({ id: "b", medium: "ethernet" });
    expect(d.upserts[1]).not.toHaveProperty("id");
    expect(d.upserts[1]).toMatchObject({ placement: "telephone_pole" });
  });

  it("a moved point is a change", () => {
    const d = C._diffRuns([run("a")], [run("a", { points: [[-85, 38], [-85, 38.002]] })]);
    expect(d.upserts.map((u: { id: string }) => u.id)).toEqual(["a"]);
  });
});

describe("lengthM mirrors the server", async () => {
  const { runLengthM } = await import("../../src/services/cableRunService.js");
  it("agrees with cableRunService.runLengthM", () => {
    const pts = [[-85.7001, 37.9801], [-85.7002, 37.9811], [-85.7015, 37.9812]];
    expect(C._lengthM(pts)).toBeCloseTo(runLengthM(pts as never), 1);
  });
});
