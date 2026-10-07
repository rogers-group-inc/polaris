/**
 * tests/unit/assistantToolService.test.ts
 *
 * Rule 94(a)–(c) at the tool layer, without a database:
 *   - every data tool checks the CALLER's role first and answers "Not
 *     permitted" without querying when the role lacks the key;
 *   - model-supplied arguments are validated (bad JSON, bad values, unknown
 *     tools come back as tool errors, never exceptions);
 *   - create_report re-runs the list tool server-side with the report cap and
 *     hands the client rows from the database, projected to the chosen columns;
 *   - list_reservations never selects the subnet's integration config.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  prisma: {
    asset: { findMany: vi.fn(), count: vi.fn(), findFirst: vi.fn(), groupBy: vi.fn() },
    reservation: { findMany: vi.fn(), count: vi.fn() },
    subnet: { findMany: vi.fn(), count: vi.fn() },
  },
  listNotifications: vi.fn(),
  searchAll: vi.fn(),
}));

vi.mock("../../src/db.js", () => ({ prisma: h.prisma }));
vi.mock("../../src/services/notificationService.js", () => ({ listNotifications: h.listNotifications }));
vi.mock("../../src/services/searchService.js", () => ({ searchAll: h.searchAll }));
vi.mock("../../src/services/regionScopeService.js", () => ({ getEffectiveRegionTags: async () => [] }));
vi.mock("../../src/services/eventLogService.js", () => ({ queryEventsPage: vi.fn(async () => ({ events: [], total: 0 })) }));
vi.mock("../../src/services/eventArchiveService.js", () => ({ getRetentionSettings: async () => ({ retentionDays: 7 }) }));

import { runAssistantTool, assistantToolDefs, REPORT_ROW_CAP } from "../../src/services/assistantToolService.js";

function reqWith(perms: Record<string, string>) {
  return { session: { userId: "u1", roleSnapshot: { permissions: perms } } } as any;
}

beforeEach(() => vi.clearAllMocks());

describe("permission gate", () => {
  const none = reqWith({});
  it.each([
    ["list_assets", "{}"],
    ["get_asset", '{"hostname":"fw1"}'],
    ["list_alerts", "{}"],
    ["list_events", "{}"],
    ["list_networks", "{}"],
    ["list_reservations", "{}"],
    ["fleet_summary", "{}"],
  ])("%s refuses a role without the key and queries nothing", async (name, args) => {
    const r = await runAssistantTool(name, args, { req: none, maxRows: 50 });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r.data)).toMatch(/Not permitted/);
    expect(h.prisma.asset.findMany).not.toHaveBeenCalled();
    expect(h.prisma.asset.findFirst).not.toHaveBeenCalled();
    expect(h.listNotifications).not.toHaveBeenCalled();
    expect(h.prisma.reservation.findMany).not.toHaveBeenCalled();
    expect(h.prisma.subnet.findMany).not.toHaveBeenCalled();
  });

  it("search asks searchAll only for the groups the role can read", async () => {
    h.searchAll.mockResolvedValue({ assets: [], subnets: [] });
    await runAssistantTool("search", '{"query":"fw1"}', { req: reqWith({ assets: "read" }), maxRows: 50 });
    expect(h.searchAll).toHaveBeenCalledWith("fw1", { blocks: false, subnets: false, reservations: false, assets: true, sites: false });
  });
});

describe("argument handling", () => {
  const req = reqWith({ assets: "read" });
  it("answers bad JSON, bad values and unknown tools as tool errors", async () => {
    expect((await runAssistantTool("list_assets", "{not json", { req, maxRows: 5 })).data).toEqual({ error: "Tool arguments were not valid JSON" });
    expect(JSON.stringify((await runAssistantTool("list_assets", '{"status":"exploded"}', { req, maxRows: 5 })).data)).toMatch(/Invalid arguments/);
    expect(JSON.stringify((await runAssistantTool("drop_tables", "{}", { req, maxRows: 5 })).data)).toMatch(/Unknown tool/);
  });

  it("caps an ordinary lookup at maxRows and reports truncation", async () => {
    h.prisma.asset.findMany.mockResolvedValue([{ hostname: "a", lastSeen: new Date("2026-10-01T00:00:00Z"), tags: ["x", "y"] }]);
    h.prisma.asset.count.mockResolvedValue(300);
    const r = await runAssistantTool("list_assets", '{"monitorStatus":"down"}', { req, maxRows: 25 });
    expect(h.prisma.asset.findMany.mock.calls[0][0].take).toBe(25);
    expect(r.data).toMatchObject({ total: 300, returned: 1, truncated: true, rows: [{ hostname: "a", lastSeen: "2026-10-01T00:00:00.000Z", tags: "x, y" }] });
  });

  it("takes one type, a list, or a comma-separated string (\"every switch and firewall\")", async () => {
    h.prisma.asset.findMany.mockResolvedValue([]);
    h.prisma.asset.count.mockResolvedValue(0);
    for (const assetType of [["switch", "firewall"], "switch, firewall"]) {
      h.prisma.asset.findMany.mockClear();
      await runAssistantTool("list_assets", JSON.stringify({ assetType }), { req, maxRows: 50 });
      const where = h.prisma.asset.findMany.mock.calls[0][0].where;
      expect(where.AND).toContainEqual({ assetType: { in: ["switch", "firewall"] } });
    }
    h.prisma.asset.findMany.mockClear();
    await runAssistantTool("list_assets", '{"assetType":"switch","monitorStatus":"down"}', { req, maxRows: 50 });
    expect(h.prisma.asset.findMany.mock.calls[0][0].where.AND).toEqual(
      expect.arrayContaining([{ assetType: { in: ["switch"] } }, { monitorStatus: { in: ["down"] }, monitored: true }]),
    );
  });

  it("a subnet filter matches by CIDR containment, not by string", async () => {
    h.prisma.asset.findMany.mockResolvedValue([
      { hostname: "in", ipAddress: "10.20.3.4" },
      { hostname: "out", ipAddress: "10.21.0.1" },
      { hostname: "lookalike", ipAddress: "110.20.3.4" },
    ]);
    const r = await runAssistantTool("list_assets", '{"network":"10.20.0.0/16"}', { req, maxRows: 50 });
    expect((r.data as any).rows.map((x: any) => x.hostname)).toEqual(["in"]);
  });
});

describe("create_report", () => {
  it("re-runs the source tool with the report cap and projects the chosen columns", async () => {
    h.prisma.asset.findMany.mockResolvedValue([{ hostname: "sw1", ipAddress: "10.0.0.2", model: "FS-148", serialNumber: "S1" }]);
    h.prisma.asset.count.mockResolvedValue(1);
    const onReport = vi.fn();
    const r = await runAssistantTool(
      "create_report",
      JSON.stringify({ title: "Switches", source: "list_assets", args: { assetType: "switch" }, columns: ["hostname", "model"] }),
      { req: reqWith({ assets: "read" }), maxRows: 10, onReport },
    );
    expect(h.prisma.asset.findMany.mock.calls[0][0].take).toBe(REPORT_ROW_CAP);
    expect(onReport).toHaveBeenCalledWith({
      title: "Switches",
      columns: [{ key: "hostname", label: "Hostname" }, { key: "model", label: "Model" }],
      rows: [{ hostname: "sw1", model: "FS-148" }],
      rowCount: 1,
      truncated: false,
    });
    expect(r.data).toMatchObject({ created: true, rowCount: 1 });
  });

  it("refuses a report over data the caller cannot read", async () => {
    const onReport = vi.fn();
    const r = await runAssistantTool("create_report", JSON.stringify({ title: "x", source: "list_alerts" }), { req: reqWith({ assets: "read" }), maxRows: 10, onReport });
    expect(r.ok).toBe(false);
    expect(onReport).not.toHaveBeenCalled();
  });
});

describe("list_reservations", () => {
  it("never selects the subnet's integration (which carries secrets)", async () => {
    h.prisma.reservation.findMany.mockResolvedValue([]);
    h.prisma.reservation.count.mockResolvedValue(0);
    await runAssistantTool("list_reservations", "{}", { req: reqWith({ reservations: "read" }), maxRows: 10 });
    const sel = JSON.stringify(h.prisma.reservation.findMany.mock.calls[0][0].select);
    expect(sel).not.toMatch(/integration|config/);
  });
});

describe("assistantToolDefs", () => {
  it("offers only read tools", () => {
    const names = assistantToolDefs().map((t) => t.function.name);
    expect(names).toContain("search_help");
    expect(names).toContain("create_report");
    for (const n of names) expect(n).not.toMatch(/^(create|update|delete|ack|push|clear|set)_(?!report)/);
  });
});
