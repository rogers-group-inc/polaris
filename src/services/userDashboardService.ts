/**
 * src/services/userDashboardService.ts
 *
 * Per-user dashboard layout persistence. Stores the operator's chosen
 * widget set + positions + sizes + per-widget config so layouts follow
 * users across browsers and devices. Layout shape validation lives at
 * the route layer (Zod); this service is the thin DB seam.
 */

import { prisma } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";

// Layout schema v3 — multiple named dashboards (tabs). Each dashboard is a
// column layout (12-grid columns of stacked widgets); `activeId` marks the
// shown tab. Replaces v2 (a single column layout) and v1 (free-grid). Older
// rows still load via GET (round-tripped untouched) and are wrapped into one
// "Dashboard 1" tab client-side in dashboard.js (normalizeLayout).
export interface DashboardLayout {
  version: 3;
  dashboards: Dashboard[];
  activeId: string;
}

interface Dashboard {
  id: string;
  name: string;
  columns: DashboardColumn[];
}

interface DashboardColumn {
  id: string;
  /** 12-grid width units: 3 | 4 | 6 | 12. */
  width: number;
  widgets: DashboardWidgetInstance[];
}

interface DashboardWidgetInstance {
  id: string;
  type: string;
  /** Row-step height: 1 | 2 | 3 (→ 280 / 576 / 872px). */
  height: number;
  config: Record<string, unknown>;
}

const EMPTY_LAYOUT: DashboardLayout = { version: 3, dashboards: [], activeId: "" };

/**
 * Returns the caller's layout, or the empty layout if no row exists yet.
 * Empty layout is the natural "Use the + Widget button to get started"
 * state — no row in the DB means the operator hasn't touched the
 * dashboard yet, and we deliberately don't seed defaults so a fresh
 * sign-in is a clean slate.
 */
export async function getLayoutForUser(userId: string): Promise<DashboardLayout> {
  const row = await prisma.userDashboard.findUnique({ where: { userId } });
  if (!row) return EMPTY_LAYOUT;
  return row.layout as unknown as DashboardLayout;
}

/**
 * Upsert the caller's layout. Caller is responsible for Zod validation
 * before calling. Returns the saved layout (round-trips so the client
 * sees exactly what the server stored).
 */
export async function saveLayoutForUser(userId: string, layout: DashboardLayout): Promise<DashboardLayout> {
  const json = layout as unknown as Prisma.InputJsonValue;
  const row = await prisma.userDashboard.upsert({
    where:  { userId },
    create: { userId, layout: json },
    update: { layout: json },
  });
  return row.layout as unknown as DashboardLayout;
}
