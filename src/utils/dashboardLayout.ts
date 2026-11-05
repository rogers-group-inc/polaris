/**
 * src/utils/dashboardLayout.ts — the ONE definition of a dashboard column.
 *
 * A dashboard canvas is an ordered list of COLUMNS, each with a 12-grid width
 * and a vertical stack of widget instances (see public/js/dashboard.js). Two
 * server surfaces store that shape and must never disagree about it:
 *
 *   - `UserDashboard.layout` — the caller's own multi-dashboard layout
 *     (src/api/routes/userDashboard.ts), where the columns sit one level down
 *     inside `dashboards[]`.
 *   - `SavedDashboard.layout` — a named, optionally PUBLIC snapshot of ONE
 *     dashboard (src/api/routes/savedDashboards.ts).
 *
 * They were one hand-copied schema away from drifting, and the drift would be
 * silent in the direction that matters: a public dashboard is replayed into
 * every other operator's browser (and into the unauthenticated Dash wallboard),
 * so the surface that accepts a wider blob is the one that decides what the
 * other has to render. Hence the caps live here too.
 */

import { z } from "zod";

/** Widgets per dashboard. Generous but bounded — a huge blob is a render cost. */
export const MAX_WIDGETS = 64;
/** Columns per dashboard (the 12-grid can't meaningfully hold more). */
export const MAX_COLUMNS = 12;
/** Named dashboards in one user's layout / tab strip. */
export const MAX_DASHBOARDS = 24;
/** Operator-typed dashboard name. Same ceiling as a saved filter's. */
export const MAX_DASHBOARD_NAME_LEN = 60;

const WidgetInstanceSchema = z.object({
  id:     z.string().uuid("widget id must be a uuid"),
  type:   z.string().min(1).max(64),
  height: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  config: z.record(z.unknown()).default({}),
});

const ColumnSchema = z.object({
  id:      z.string().uuid("column id must be a uuid"),
  width:   z.union([z.literal(3), z.literal(4), z.literal(6), z.literal(12)]),
  widgets: z.array(WidgetInstanceSchema).max(MAX_WIDGETS),
});

/**
 * A bare column stack — the unit both surfaces store. The per-dashboard widget
 * total is checked here rather than per column, since 12 columns of 64 widgets
 * would each pass the array cap and together be 768.
 */
export const ColumnsSchema = z
  .array(ColumnSchema)
  .max(MAX_COLUMNS)
  .superRefine((columns, ctx) => {
    const total = columns.reduce((n, c) => n + c.widgets.length, 0);
    if (total > MAX_WIDGETS) {
      ctx.addIssue({ code: "custom", message: `too many widgets (max ${MAX_WIDGETS})` });
    }
  });

export type DashboardColumnInput = z.infer<typeof ColumnSchema>;
