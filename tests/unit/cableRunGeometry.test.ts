/**
 * tests/unit/cableRunGeometry.test.ts
 *
 * The geometry of a device link routed through cable runs
 * (public/js/cable-run-geometry.js, business rule 184(a)): the link joins a
 * run at its point nearest each device, follows the run between them in
 * either direction, crosses between runs where they come closest, and is
 * straight when it rides nothing. Synthetic coordinates only.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";

let G: Record<string, any>;

beforeAll(() => {
  const sb: Record<string, any> = { window: {}, console, Math };
  vm.createContext(sb);
  vm.runInContext(readFileSync(resolve(__dirname, "../../public/js/cable-run-geometry.js"), "utf8"), sb);
  G = sb.window.PolarisCableRunGeometry;
});

const plain = (v: unknown) => JSON.parse(JSON.stringify(v));
const close = (a: number[], b: number[], eps = 1e-6) => Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps;

// An east-west run along latitude 10, from lng 0 to lng 0.003, with a bend.
const RUN = { id: "r1", points: [[0, 10], [0.001, 10], [0.002, 10.0005], [0.003, 10]] };

describe("route", () => {
  it("is straight when the link rides no run", () => {
    expect(plain(G.route([0, 0], [1, 1], []))).toEqual([[0, 0], [1, 1]]);
  });

  it("joins the run at the point nearest each device and follows it between them", () => {
    const S = [0.0002, 10.001];
    const T = [0.0028, 10.001];
    const r = plain(G.route(S, T, [RUN]));
    expect(r[0]).toEqual(S);
    expect(r[r.length - 1]).toEqual(T);
    // Joins straight below S (the run is flat there).
    expect(close(r[1], [0.0002, 10], 1e-7)).toBe(true);
    // Rides through every vertex between, in order…
    expect(r.slice(2, 4)).toEqual([[0.001, 10], [0.002, 10.0005]]);
    // …and leaves from the last, sloped segment, before its end vertex.
    expect(r).toHaveLength(6);
    expect(r[4][0]).toBeGreaterThan(0.002);
    expect(r[4][0]).toBeLessThan(0.003);
  });

  it("follows the run backwards when the devices are the other way round", () => {
    const r = plain(G.route([0.0028, 10.001], [0.0002, 10.001], [RUN]));
    const inner = r.slice(2, -2).map((p: number[]) => p[0]);
    expect(inner).toEqual([0.002, 0.001]);
  });

  it("crosses between two runs where they come closest", () => {
    const north = { id: "n", points: [[0.004, 10], [0.004, 10.003]] };
    const r = plain(G.route([0, 10.0001], [0.0041, 10.003], [RUN, north]));
    // Leaves RUN at its end (0.003, 10) — nearest to the north run — and
    // joins the north run at its start (0.004, 10).
    expect(r.some((p: number[]) => close(p, [0.003, 10]))).toBe(true);
    expect(r.some((p: number[]) => close(p, [0.004, 10]))).toBe(true);
    expect(close(r[r.length - 2], [0.004, 10.003], 1e-7)).toBe(true);
  });
});

describe("orderRuns", () => {
  it("orders runs from the source device to the target", () => {
    const a = { id: "a", points: [[0, 0], [0.001, 0]] };
    const b = { id: "b", points: [[0.005, 0], [0.006, 0]] };
    expect(plain(G.orderRuns([0, 0], [0.006, 0], [b, a])).map((r: { id: string }) => r.id)).toEqual(["a", "b"]);
    expect(plain(G.orderRuns([0.006, 0], [0, 0], [a, b])).map((r: { id: string }) => r.id)).toEqual(["b", "a"]);
  });
});

describe("rideMidpoint", () => {
  it("sits on the run, between where the link joins and leaves it", () => {
    const m = plain(G.rideMidpoint([0, 10.001], [0.003, 10.001], [RUN], 0));
    expect(m[0]).toBeGreaterThan(0.0005);
    expect(m[0]).toBeLessThan(0.0025);
    expect(G.nearest(RUN.points, m).dist).toBeLessThan(0.01);
  });
});
