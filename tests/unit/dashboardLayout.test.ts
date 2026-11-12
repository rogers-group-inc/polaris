/**
 * tests/unit/dashboardLayout.test.ts
 *
 * The one dashboard-column schema shared by UserDashboard and SavedDashboard,
 * with its caps: 12 columns, 64 widgets per DASHBOARD (not per column),
 * widths 3/4/6/12, heights 1/2/3, uuid ids.
 */

import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  ColumnsSchema,
  MAX_COLUMNS,
  MAX_WIDGETS,
  MAX_DASHBOARDS,
  MAX_DASHBOARD_NAME_LEN,
} from "../../src/utils/dashboardLayout.js";

const widget = (over: Record<string, unknown> = {}) => ({ id: randomUUID(), type: "status", height: 1, ...over });
const column = (widgets: unknown[] = [], over: Record<string, unknown> = {}) => ({ id: randomUUID(), width: 6, widgets, ...over });

describe("dashboardLayout caps", () => {
  it("pins the ceilings", () => {
    expect(MAX_WIDGETS).toBe(64);
    expect(MAX_COLUMNS).toBe(12);
    expect(MAX_DASHBOARDS).toBe(24);
    expect(MAX_DASHBOARD_NAME_LEN).toBe(60);
  });
});

describe("ColumnsSchema", () => {
  it("accepts a valid layout and defaults a widget's config to {}", () => {
    const parsed = ColumnsSchema.parse([column([widget()])]);
    expect(parsed[0].widgets[0].config).toEqual({});
  });

  it("accepts an empty layout", () => {
    expect(ColumnsSchema.safeParse([]).success).toBe(true);
  });

  it("rejects a width outside 3/4/6/12 and a height outside 1/2/3", () => {
    expect(ColumnsSchema.safeParse([column([], { width: 5 })]).success).toBe(false);
    expect(ColumnsSchema.safeParse([column([widget({ height: 4 })])]).success).toBe(false);
  });

  it("rejects non-uuid ids", () => {
    expect(ColumnsSchema.safeParse([column([], { id: "col-1" })]).success).toBe(false);
    expect(ColumnsSchema.safeParse([column([widget({ id: "w1" })])]).success).toBe(false);
  });

  it("rejects an empty or over-long widget type", () => {
    expect(ColumnsSchema.safeParse([column([widget({ type: "" })])]).success).toBe(false);
    expect(ColumnsSchema.safeParse([column([widget({ type: "x".repeat(65) })])]).success).toBe(false);
  });

  it("caps the number of columns", () => {
    const ok = Array.from({ length: MAX_COLUMNS }, () => column());
    expect(ColumnsSchema.safeParse(ok).success).toBe(true);
    expect(ColumnsSchema.safeParse([...ok, column()]).success).toBe(false);
  });

  it("caps widgets per DASHBOARD, not just per column", () => {
    const half = () => Array.from({ length: 33 }, () => widget());
    const res = ColumnsSchema.safeParse([column(half()), column(half())]);
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error.issues.some((i) => /too many widgets/.test(i.message))).toBe(true);
    const exact = ColumnsSchema.safeParse([column(Array.from({ length: 32 }, () => widget())), column(half().slice(0, 32))]);
    expect(exact.success).toBe(true);
  });
});
