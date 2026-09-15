/**
 * tests/unit/automationActions.test.ts — B4 action execution:
 *   - automationActionService.executeActions fan-out (notify → expandDeliveries
 *     with per-action-else-rule composition; api_call → NotificationDelivery
 *     row with fire-time-rendered body; script → warning Event, never blocks
 *     the remaining actions),
 *   - apiCallChannel.sendApiCall (method/headers/body/timeout + SSRF guard),
 *   - drainPendingDeliveries permanent-fail semantics: an api_call row's NULL
 *     channelId takes the retry path; a notify row with a deleted channel
 *     still fails permanently.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── module mocks ─────────────────────────────────────────────────────────────
const created: any[] = [];
const deliveryRows: any[] = [];
const deliveryUpdates: any[] = [];
let channelRows: any[] = [];

vi.mock("../../src/db.js", () => ({
  prisma: {
    notificationDelivery: {
      create: vi.fn(async ({ data }: any) => {
        created.push(data);
        return { id: "d1", ...data };
      }),
      findMany: vi.fn(async () => deliveryRows),
      updateMany: vi.fn(async (args: any) => {
        deliveryUpdates.push({ kind: "updateMany", args });
        return { count: 1 };
      }),
      update: vi.fn(async (args: any) => {
        deliveryUpdates.push({ kind: "update", args });
        return {};
      }),
    },
    notificationChannel: { findMany: vi.fn(async () => channelRows) },
    pushSubscription: { deleteMany: vi.fn(async () => ({ count: 0 })) },
  },
}));

const logEventMock = vi.fn(async () => {});
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: (...a: unknown[]) => logEventMock(...a) }));

const expandDeliveriesMock = vi.fn(async () => 1);
vi.mock("../../src/services/notificationRecipientService.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, expandDeliveries: (...a: unknown[]) => expandDeliveriesMock(...a) };
});

import { executeActions } from "../../src/services/automationActionService.js";
import { sendApiCall } from "../../src/services/notificationChannels/apiCallChannel.js";
import { drainPendingDeliveries } from "../../src/services/notificationDeliveryService.js";
import type { AutomationAction } from "../../src/services/notificationTypes.js";

beforeEach(() => {
  created.length = 0;
  deliveryRows.length = 0;
  deliveryUpdates.length = 0;
  channelRows = [];
  expandDeliveriesMock.mockClear();
  logEventMock.mockClear();
  vi.unstubAllGlobals();
});

// "trigger.summary" is what the shared default body leads with; {message} is
// deliberately not printed under it (on a fire the two said the same thing).
const CTX = { asset: "sw-core-1", value: "95", threshold: "90", severity: "warning", message: "hot", "trigger.summary": "CPU utilization is 95%" };

describe("executeActions", () => {
  it("notify: per-action emailComposition wins, rule-level is the fallback", async () => {
    const actions: AutomationAction[] = [
      { type: "notify", channelId: "c1", addresses: ["a@example.com"], emailComposition: { subjectTemplate: "action-level {asset}" } },
      { type: "notify", channelId: "c2", emailComposition: null },
    ];
    await executeActions("n1", actions, CTX, { ruleEmailComposition: { subjectTemplate: "rule-level {asset}" }, scopeRegionTags: ["region:East"], assetRegionTags: ["Atlanta"] });

    expect(expandDeliveriesMock).toHaveBeenCalledTimes(2);
    const [firstCall, secondCall] = expandDeliveriesMock.mock.calls as any[];
    // targets converted from the action (per-action composition never leaks into the target)
    expect(firstCall[1]).toEqual([{ channelId: "c1", addresses: ["a@example.com"] }]);
    expect(firstCall[2].scopeRegionTags).toEqual(["region:East"]);
    // The triggering asset's region snapshot rides through for recipientDeviceRegion routing.
    expect(firstCall[2].assetRegionTags).toEqual(["Atlanta"]);
    expect(firstCall[2].composedEmail.subject).toBe("action-level sw-core-1");
    expect(secondCall[2].composedEmail.subject).toBe("rule-level sw-core-1");
  });

  it("notify without any composition still composes — from the shared default alert body", async () => {
    // This used to pass composedEmail: undefined, dropping such alerts onto
    // the legacy "message + View:" path — exactly the sparse two-line email
    // the rich default replaced. Every notify composes now; blank pieces fall
    // back to the default template inside buildComposedEmail.
    await executeActions("n1", [{ type: "notify", channelId: "c1" }], CTX, {});
    const composed = (expandDeliveriesMock.mock.calls[0] as any[])[2].composedEmail;
    expect(composed).toBeDefined();
    expect(composed.subject).toContain("sw-core-1");
    expect(composed.text).toContain("CPU utilization is 95%"); // what fired leads
    // Deferred tokens survive compose: filled per recipient / per delivery.
    expect(composed.text).toContain("{ack}");
    expect(composed.html).toContain("Acknowledge alert");
  });

  it("an all-clear asks for no acknowledge button; a fire asks for one", async () => {
    // The "resolved" pseudo-severity is what the three all-clear paths
    // (fireResolved, fireReset, the operator-clear path) already stamp to
    // colour the email green, so it is also what tells the expander this send
    // has nothing left to acknowledge — business rule 25. Anything else is a
    // fire, and must not pass the flag at all: `undefined` is the shape that
    // keeps a firing send byte-identical.
    await executeActions("n1", [{ type: "notify", channelId: "c1" }], { ...CTX, severity: "resolved" }, {});
    expect((expandDeliveriesMock.mock.calls[0] as any[])[2].noAck).toBe(true);

    expandDeliveriesMock.mockClear();
    await executeActions("n1", [{ type: "notify", channelId: "c1" }], CTX, {});
    expect((expandDeliveriesMock.mock.calls[0] as any[])[2].noAck).toBeUndefined();
  });

  it("api_call: creates a NULL-channel delivery row with the body rendered at fire time", async () => {
    const actions: AutomationAction[] = [
      { type: "api_call", method: "POST", url: "https://hooks.example.com/x", headers: { "X-Env": "prod" }, bodyTemplate: '{"asset":"{asset}","v":{value}}', timeoutSec: 20 },
    ];
    await executeActions("n1", actions, CTX, { escalation: { tier: 2, attempt: 1 } });

    expect(created).toHaveLength(1);
    const row = created[0];
    expect(row.notificationId).toBe("n1");
    expect(row.channelId).toBeNull();
    expect(row.transport).toBe("api_call");
    expect(row.target).toBe("https://hooks.example.com/x");
    expect(row.meta).toMatchObject({
      apiCall: true,
      method: "POST",
      url: "https://hooks.example.com/x",
      headers: { "X-Env": "prod" },
      body: '{"asset":"sw-core-1","v":95}',
      timeoutSec: 20,
      escalation: { tier: 2, attempt: 1 },
    });
  });

  it("a failing action logs a warning Event and never blocks later actions", async () => {
    const actions: AutomationAction[] = [
      { type: "script", scriptId: "s1", runOn: "server" }, // stubbed to fail until the registry phase
      { type: "notify", channelId: "c1" },
    ];
    await executeActions("n1", actions, CTX, { ruleName: "test rule" });

    expect(logEventMock).toHaveBeenCalledTimes(1);
    const evt = logEventMock.mock.calls[0]![0] as any;
    expect(evt.action).toBe("automation.action_error");
    expect(evt.level).toBe("warning");
    expect(evt.details.actionType).toBe("script");
    // the notify action after the failure still ran
    expect(expandDeliveriesMock).toHaveBeenCalledTimes(1);
  });
});

describe("sendApiCall", () => {
  function stubFetch(status = 200) {
    const fetchMock = vi.fn(async () => ({ ok: status >= 200 && status < 300, status }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("POSTs with a default JSON content-type when a body is present", async () => {
    const fetchMock = stubFetch();
    await sendApiCall({ method: "POST", url: "https://api.example.com/y", body: "{}" });
    const [url, init] = fetchMock.mock.calls[0]! as any;
    expect(url).toBe("https://api.example.com/y");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.body).toBe("{}");
  });

  it("respects an operator-set content-type and drops the body on GET", async () => {
    const fetchMock = stubFetch();
    await sendApiCall({ method: "POST", url: "https://api.example.com/y", body: "x", headers: { "content-type": "text/plain" } });
    expect((fetchMock.mock.calls[0]![1] as any).headers["Content-Type"]).toBeUndefined();
    await sendApiCall({ method: "GET", url: "https://api.example.com/y", body: "ignored" });
    expect((fetchMock.mock.calls[1]![1] as any).body).toBeUndefined();
  });

  it("throws on a non-2xx response (drain retries)", async () => {
    stubFetch(503);
    await expect(sendApiCall({ method: "POST", url: "https://api.example.com/y" })).rejects.toThrow(/HTTP 503/);
  });

  it("refuses loopback/metadata hosts (SSRF guard)", async () => {
    const fetchMock = stubFetch();
    await expect(sendApiCall({ method: "POST", url: "http://127.0.0.1/admin" })).rejects.toThrow();
    await expect(sendApiCall({ method: "POST", url: "http://169.254.169.254/latest/meta-data" })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("drainPendingDeliveries permanent-fail semantics", () => {
  const notification = { id: "n1", message: "m", severity: "warning", assetHostname: "h", triggeredAt: new Date() };

  it("api_call with NULL channel retries on failure; email with a deleted channel fails permanently", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500 })));
    deliveryRows.push(
      { id: "d-api", channelId: null, transport: "api_call", target: "https://api.example.com/x", meta: { apiCall: true, method: "POST", url: "https://api.example.com/x" }, attempts: 0, notification },
      { id: "d-mail", channelId: "gone", transport: "email", target: "a@example.com", meta: {}, attempts: 0, notification },
    );
    channelRows = []; // the email row's channel no longer exists

    const res = await drainPendingDeliveries();
    expect(res.failed).toBe(2);

    const apiUpdate = deliveryUpdates.find((u) => u.kind === "update" && u.args.where.id === "d-api")!.args.data;
    const mailUpdate = deliveryUpdates.find((u) => u.kind === "update" && u.args.where.id === "d-mail")!.args.data;
    expect(apiUpdate.status).toBe("pending"); // retry path — NULL channel is legitimate for api_call
    expect(mailUpdate.status).toBe("failed"); // deleted channel = permanent
  });

  it("a successful api_call marks sent", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200 })));
    deliveryRows.push({ id: "d-api", channelId: null, transport: "api_call", target: "https://api.example.com/x", meta: { apiCall: true, method: "POST", url: "https://api.example.com/x" }, attempts: 0, notification });

    const res = await drainPendingDeliveries();
    expect(res.sent).toBe(1);
    const sentUpdate = deliveryUpdates.find((u) => u.kind === "updateMany")!.args;
    expect(sentUpdate.where.id.in).toEqual(["d-api"]);
    expect(sentUpdate.data.status).toBe("sent");
  });

  it("an api_call exhausting attempts goes failed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500 })));
    deliveryRows.push({ id: "d-api", channelId: null, transport: "api_call", target: "https://api.example.com/x", meta: { apiCall: true, method: "POST", url: "https://api.example.com/x" }, attempts: 2, notification });

    await drainPendingDeliveries();
    const upd = deliveryUpdates.find((u) => u.kind === "update")!.args.data;
    expect(upd.status).toBe("failed"); // attempts 2 + 1 = MAX_ATTEMPTS
  });
});
