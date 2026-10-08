/**
 * tests/unit/alertDependencyPathDelivery.test.ts — the delivery drain fills
 * `{dependency.path}` (alertDependencyPathService, business rule 78): the
 * diagram's PNG rides as an inline attachment on a dependency-down alert, one
 * build serves every email row of the alert, and every other alert loses the
 * token without a read.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const { sent, rows, assetFindMany } = vi.hoisted(() => {
  const mk = (id: string, notification: Record<string, unknown>, extraMeta: Record<string, unknown> = {}) => ({
    id,
    channelId: "c-mail",
    transport: "email",
    target: `${id}@example.com`,
    meta: {
      composed: true,
      to: [`${id}@example.com`],
      subject: "S",
      text: "Facts\n{dependency.path}\nEnd",
      html: "<table>{dependency.path}</table>",
      ...extraMeta,
    },
    attempts: 0,
    notification: {
      message: "down",
      severity: "error",
      assetHostname: "PLC-7",
      dimension: null,
      metric: "monitorStatus",
      ruleId: "r1",
      triggeredAt: new Date("2026-10-02T12:00:00Z"),
      testRun: false,
      members: null,
      ...notification,
    },
  });
  const dep = {
    id: "n-dep",
    assetId: "plc",
    dependencyDown: true,
    dependencyBlame: { chain: [{ id: "sw", hostname: "SW-1", reason: "down" }], hops: 1 },
  };
  return {
    sent: [] as Array<{ html?: string; text: string; attachments?: Array<{ cid: string }> }>,
    rows: {
      list: [] as unknown[],
      dep: [mk("d1", dep), mk("d2", dep)],
      plain: [mk("p1", { id: "n-plain", assetId: "srv", dependencyDown: false, dependencyBlame: null })],
      // The firing email and the all-clear of ONE alert, draining together.
      both: [mk("f1", dep), mk("c1", dep, { allClear: true })],
    },
    assetFindMany: vi.fn(async () => [
      { id: "sw", hostname: "SW-1", location: null, description: "a:Mine jb:JB-3", fortinetTopology: null, lastSeenSwitch: null, status: "active", monitorStatus: "up", dependencySuppressed: false },
      { id: "plc", hostname: "PLC-7", location: "Shop", description: null, fortinetTopology: null, lastSeenSwitch: "SW-1/port9", status: "active", monitorStatus: "recovering", dependencySuppressed: false },
    ]),
  };
});

vi.mock("../../src/db.js", () => ({
  prisma: {
    notificationDelivery: {
      findMany: vi.fn(async () => rows.list),
      updateMany: vi.fn(async () => ({ count: 1 })),
      update: vi.fn(async () => ({})),
    },
    notificationChannel: {
      findMany: vi.fn(async () => [
        { id: "c-mail", type: "smtp", enabled: true, config: { host: "mail", from: "a@b.c" } },
      ]),
    },
    notificationRule: { findUnique: vi.fn(async () => ({ trigger: {} })) },
    pushSubscription: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    asset: { findMany: assetFindMany },
    assetLldpNeighbor: { findMany: vi.fn(async () => []) },
  },
}));

vi.mock("@resvg/resvg-js", () => ({
  Resvg: class {
    render() { return { asPng: () => new Uint8Array([1, 2, 3]) }; }
  },
}));

vi.mock("../../src/services/notificationChannels/emailChannel.js", () => ({
  sendSmtpEmail: vi.fn(async (_cfg: unknown, msg: unknown) => { sent.push(msg as never); }),
  sendM365Email: vi.fn(async () => {}),
}));

vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: vi.fn(async () => {}) }));

import { drainPendingDeliveries } from "../../src/services/notificationDeliveryService.js";
import { DEPENDENCY_PATH_CID } from "../../src/services/alertDependencyPathService.js";

beforeEach(() => {
  sent.length = 0;
  assetFindMany.mockClear();
});

describe("{dependency.path} in the delivery drain", () => {
  it("embeds the diagram once per alert across its email rows", async () => {
    rows.list = rows.dep;
    const res = await drainPendingDeliveries();
    expect(res.sent).toBe(2);
    expect(assetFindMany).toHaveBeenCalledTimes(1);
    for (const msg of sent) {
      expect(msg.html).toContain(`cid:${DEPENDENCY_PATH_CID}`);
      expect(msg.attachments?.map((a) => a.cid)).toContain(DEPENDENCY_PATH_CID);
      expect(msg.text).toContain("Dependency path  SW-1 [Mine / JB-3] (down) → PLC-7 [Shop] (this alert)");
    }
  });

  it("removes the token from every other alert without a read", async () => {
    rows.list = rows.plain;
    await drainPendingDeliveries();
    expect(assetFindMany).not.toHaveBeenCalled();
    expect(sent[0].html).toBe("<table></table>");
    expect(sent[0].text).not.toContain("{dependency.path}");
    expect(sent[0].attachments ?? []).toHaveLength(0);
  });

  it("draws the all-clear in each device's state NOW, and never reuses the firing render", async () => {
    // The resolve email used to repeat the outage picture (red root cause, grey
    // Dep. Down) under a green header. Same devices, same order — coloured by
    // what each reads at delivery, which is read rather than assumed: PLC-7's
    // own count has not drained yet, and the picture says so.
    rows.list = rows.both;
    await drainPendingDeliveries();
    const [fire, clear] = sent;
    expect(fire.text).toContain("Dependency path  SW-1 [Mine / JB-3] (down) → PLC-7 [Shop] (this alert)");
    expect(clear.text).toContain("Dependency path now  SW-1 [Mine / JB-3] (up) → PLC-7 [Shop] (this alert, recovering)");
    expect(clear.html).toContain("Dependency path now");
    expect(clear.attachments?.map((a) => a.cid)).toContain(DEPENDENCY_PATH_CID);
    // Two renders: one per kind of send, each shared across that send's rows.
    expect(assetFindMany).toHaveBeenCalledTimes(2);
  });
});
