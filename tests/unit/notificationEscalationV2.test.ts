/**
 * tests/unit/notificationEscalationV2.test.ts — B7 escalation v2:
 * the sweep drives tiers through automationActionService.executeActions.
 *
 * The load-bearing suite is LEGACY OUTPUT PARITY: a pre-v2 email tier swept
 * through the new pipeline must produce delivery rows identical to the old
 * sweep's (per-field tier→rule composition fallback, always-composed,
 * "[ESCALATION n]" default-subject prefix, tier-only cc/bcc, escalation meta,
 * retry-until-something-sends state semantics). Plus: v2 tiers carrying
 * api_call actions execute + the acknowledged/stopOn gate.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const db = {
  rules: [] as any[],
  notifs: [] as any[],
  channels: [] as any[],
  deliveries: [] as any[],
  notifUpdates: [] as any[],
};

vi.mock("../../src/db.js", () => ({
  prisma: {
    notificationRule: { findMany: vi.fn(async () => db.rules) },
    // Alert groups (business rule 75): the sweep also loads GROUP-owned
    // chains. No group in these fixtures, so every alert resolves its owner
    // to its own automation exactly as before.
    alertGroup: { findMany: vi.fn(async () => []) },
    notification: {
      findMany: vi.fn(async () => db.notifs),
      update: vi.fn(async (args: any) => {
        db.notifUpdates.push(args);
        return {};
      }),
    },
    asset: { findMany: vi.fn(async () => []) },
    notificationChannel: { findMany: vi.fn(async ({ where }: any) => db.channels.filter((c) => where.id.in.includes(c.id))) },
    notificationDelivery: {
      createMany: vi.fn(async ({ data }: any) => {
        db.deliveries.push(...data);
        return { count: data.length };
      }),
      create: vi.fn(async ({ data }: any) => {
        db.deliveries.push(data);
        return { id: "d", ...data };
      }),
    },
    user: { findMany: vi.fn(async () => []) },
    pushSubscription: { findMany: vi.fn(async () => []) },
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  },
}));

vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: vi.fn(async () => {}) }));

import { runEscalationSweep, tierIsDue } from "../../src/services/notificationEscalationService.js";

const NOW = new Date("2026-07-21T12:00:00Z");
const T35_AGO = new Date(NOW.getTime() - 35 * 60_000);

const CTX = {
  asset: "sw-core-1",
  value: "95",
  threshold: "90",
  severity: "warning",
  "severity.upper": "WARNING",
  link: "",
  message: "cpu hot",
  // What the shared body leads with — the message is not printed under it.
  "trigger.summary": "CPU utilization is 95%",
};

function seedRule(overrides: Record<string, unknown> = {}) {
  db.rules.push({
    id: "r1",
    name: "cpu rule",
    description: null,
    scope: {},
    emailComposition: null,
    escalation: null,
    targets: [],
    clearBehavior: "manual",
    clearAfterSec: null,
    reset: { mode: "manual" },
    actions: [],
    ...overrides,
  });
}

function seedNotif(overrides: Record<string, unknown> = {}) {
  db.notifs.push({
    id: "n1",
    ruleId: "r1",
    assetId: null,
    assetHostname: "sw-core-1",
    severity: "warning",
    message: "cpu hot",
    triggeredAt: T35_AGO,
    acknowledged: false,
    templateCtx: CTX,
    escalationState: null,
    ...overrides,
  });
}

beforeEach(() => {
  db.rules.length = 0;
  db.notifs.length = 0;
  db.channels.length = 0;
  db.deliveries.length = 0;
  db.notifUpdates.length = 0;
  db.channels.push({ id: "ch-email", type: "smtp", enabled: true });
});

describe("legacy email-tier output parity", () => {
  it("tier with no overrides renders the RULE composition (no prefix) with tier recipients + escalation meta", async () => {
    seedRule({
      emailComposition: { subjectTemplate: "RULE {asset}", bodyTextTemplate: "BODY {value}" },
      escalation: { stopOn: "acknowledge", tiers: [{ afterMin: 30, channelId: "ch-email", to: { addresses: ["oncall@example.com"] } }] },
    });
    seedNotif();

    const runs = await runEscalationSweep(NOW);
    expect(runs).toBe(1);
    expect(db.deliveries).toHaveLength(1);
    const row = db.deliveries[0];
    expect(row.channelId).toBe("ch-email");
    expect(row.transport).toBe("email");
    expect(row.target).toBe("oncall@example.com");
    expect(row.meta).toMatchObject({
      composed: true,
      to: ["oncall@example.com"],
      cc: [],
      bcc: [],
      subject: "RULE sw-core-1",
      text: "BODY 95",
      escalation: { tier: 1, attempt: 1 },
    });
    // The rule supplied subject + text but no HTML, so the HTML half falls
    // back to the shared default body (an escalation is still an alert email).
    expect(row.meta.html).toContain("sw-core-1");
    // escalationState bookkeeping
    expect(db.notifUpdates).toHaveLength(1);
    expect(db.notifUpdates[0].data.escalationState.tiers["0"].count).toBe(1);
  });

  it("no subject template anywhere → default subject with the [ESCALATION n] prefix", async () => {
    seedRule({
      escalation: { stopOn: "acknowledge", tiers: [{ afterMin: 30, channelId: "ch-email", to: { addresses: ["a@example.com"] } }] },
    });
    seedNotif();
    await runEscalationSweep(NOW);
    // The default subject is "[SEV] asset — rule", but this notification's
    // stored templateCtx carries no `rule` key (it predates the token), so the
    // name renders blank and the dangling separator is trimmed rather than
    // mailed as "sw-core-1 — {rule}". The tier prefix still leads.
    expect(db.deliveries[0].meta.subject).toBe("[ESCALATION 1] [WARNING] sw-core-1");
    // Default body = the shared rich alert template, led by what fired.
    expect(db.deliveries[0].meta.text).toContain("CPU utilization is 95%");
    expect(db.deliveries[0].meta.text).toContain("Subject:    sw-core-1");
    // This tier mails a RAW ADDRESS, which earns no acknowledge token — only a
    // configured Polaris user can acknowledge. So the whole Acknowledge line
    // is stripped rather than mailed as a label with nothing behind it, and
    // certainly not as the literal "{ack}".
    expect(db.deliveries[0].meta.text).not.toContain("Acknowledge:");
    expect(db.deliveries[0].meta.text).not.toContain("{ack}");
  });

  it("tier subject-only override keeps the RULE body (per-field merge) and tier cc", async () => {
    seedRule({
      emailComposition: { subjectTemplate: "RULE {asset}", bodyTextTemplate: "BODY {value}" },
      escalation: {
        stopOn: "acknowledge",
        tiers: [{
          afterMin: 30, channelId: "ch-email",
          to: { addresses: ["a@example.com"] },
          cc: { addresses: ["cc@example.com"] },
          subjectTemplate: "TIER {escalation.tier} {asset}",
        }],
      },
    });
    seedNotif();
    await runEscalationSweep(NOW);
    const meta = db.deliveries[0].meta;
    expect(meta.subject).toBe("TIER 1 sw-core-1"); // tier wins, no prefix
    expect(meta.text).toBe("BODY 95"); // rule body survives a subject-only override
    expect(meta.cc).toEqual(["cc@example.com"]);
  });

  it("a tier whose channel is disabled does NOT count as sent — retried next sweep", async () => {
    db.channels[0].enabled = false;
    seedRule({
      escalation: { stopOn: "acknowledge", tiers: [{ afterMin: 30, channelId: "ch-email", to: { addresses: ["a@example.com"] } }] },
    });
    seedNotif();
    const runs = await runEscalationSweep(NOW);
    expect(runs).toBe(0);
    expect(db.deliveries).toHaveLength(0);
    expect(db.notifUpdates).toHaveLength(0); // no state bump → tier stays due
  });

  it("acknowledged notification stops stopOn=acknowledge but not stopOn=clear", async () => {
    seedRule({
      escalation: { stopOn: "acknowledge", tiers: [{ afterMin: 30, channelId: "ch-email", to: { addresses: ["a@example.com"] } }] },
    });
    seedNotif({ acknowledged: true });
    expect(await runEscalationSweep(NOW)).toBe(0);

    db.rules[0].escalation.stopOn = "clear";
    expect(await runEscalationSweep(NOW)).toBe(1);
  });
});

describe("v2 tiers of actions", () => {
  it("an api_call tier action enqueues a NULL-channel delivery with escalation meta + rendered body", async () => {
    seedRule({
      escalation: {
        stopOn: "acknowledge",
        tiers: [{
          afterMin: 30,
          actions: [{ type: "api_call", method: "POST", url: "https://pager.example.com/esc", bodyTemplate: '{"asset":"{asset}","tier":{escalation.tier}}', timeoutSec: 15 }],
        }],
      },
    });
    seedNotif();
    const runs = await runEscalationSweep(NOW);
    expect(runs).toBe(1);
    expect(db.deliveries).toHaveLength(1);
    const row = db.deliveries[0];
    expect(row.transport).toBe("api_call");
    expect(row.channelId).toBeNull();
    expect(row.meta.body).toBe('{"asset":"sw-core-1","tier":1}');
    expect(row.meta.escalation).toEqual({ tier: 1, attempt: 1 });
  });

  it("a mixed tier (notify + api_call) executes both from one due tier", async () => {
    seedRule({
      escalation: {
        stopOn: "acknowledge",
        tiers: [{
          afterMin: 30,
          actions: [
            { type: "notify", channelId: "ch-email", addresses: ["a@example.com"], emailComposition: null },
            { type: "api_call", method: "POST", url: "https://pager.example.com/esc", timeoutSec: 15 },
          ],
        }],
      },
    });
    seedNotif();
    expect(await runEscalationSweep(NOW)).toBe(1);
    const transports = db.deliveries.map((d) => d.transport).sort();
    expect(transports).toEqual(["api_call", "email"]);
    // notify action in an escalation is ALWAYS composed (legacy semantics)
    const email = db.deliveries.find((d) => d.transport === "email")!;
    expect(email.meta.composed).toBe(true);
    expect(email.meta.subject).toBe("[ESCALATION 1] [WARNING] sw-core-1");
  });
});

describe("per-band escalation (value-driven)", () => {
  const critBandEsc = {
    threshold: 65,
    severity: "critical",
    actions: [],
    escalation: { stopOn: "acknowledge", tiers: [{ afterMin: 30, actions: [{ type: "api_call", method: "POST", url: "https://pager.example.com/crit", timeoutSec: 15 }] }] },
  };

  it("runs the CURRENT band's escalation chain (selected by the alert's severity)", async () => {
    seedRule({ severity: "warning", escalation: null, severityBands: [critBandEsc] });
    seedNotif({ severity: "critical" }); // in the critical band
    const runs = await runEscalationSweep(NOW);
    expect(runs).toBe(1);
    expect(db.deliveries).toHaveLength(1);
    expect(db.deliveries[0].transport).toBe("api_call");
  });

  it("does NOT escalate a base-severity alert when only a band carries escalation", async () => {
    seedRule({ severity: "warning", escalation: null, severityBands: [critBandEsc] });
    seedNotif({ severity: "warning" }); // still at tier 0, which has no escalation
    expect(await runEscalationSweep(NOW)).toBe(0);
    expect(db.deliveries).toHaveLength(0);
  });

  it("measures band-tier delays from bandSince (a freshly-entered band restarts the timer)", async () => {
    seedRule({ severity: "warning", escalation: null, severityBands: [critBandEsc] });
    // Fired 35m ago, but only entered the critical band 5m ago → tier(afterMin 30) not due yet.
    seedNotif({ severity: "critical", escalationState: { tiers: {}, bandSince: new Date(NOW.getTime() - 5 * 60_000).toISOString() } });
    expect(await runEscalationSweep(NOW)).toBe(0);

    // Entered the band 31m ago → now due.
    db.notifs[0].escalationState = { tiers: {}, bandSince: new Date(NOW.getTime() - 31 * 60_000).toISOString() };
    expect(await runEscalationSweep(NOW)).toBe(1);
  });
});

describe("per-action escalation chains", () => {
  const actionChain = (url: string, stopOn = "acknowledge") => ({
    stopOn,
    tiers: [{ afterMin: 30, actions: [{ type: "api_call", method: "POST", url, timeoutSec: 15 }] }],
  });

  it("an action's own chain runs alongside the rule-level chain with disjoint state keys", async () => {
    seedRule({
      actions: [{ type: "notify", channelId: "ch-email", addresses: ["a@example.com"], escalation: actionChain("https://pager.example.com/action0") }],
      escalation: actionChain("https://pager.example.com/rule"),
    });
    seedNotif();
    const runs = await runEscalationSweep(NOW);
    expect(runs).toBe(2);
    const urls = db.deliveries.map((d) => d.meta.url).sort();
    expect(urls).toEqual(["https://pager.example.com/action0", "https://pager.example.com/rule"]);
    // Level chain keeps the bare numeric key; the per-action chain keys a0:t0.
    const state = db.notifUpdates[0].data.escalationState.tiers;
    expect(Object.keys(state).sort()).toEqual(["0", "a0:t0"]);
  });

  it("stopOn is per chain: ack stops the acknowledge chain, the clear chain keeps escalating", async () => {
    seedRule({
      actions: [{ type: "notify", channelId: "ch-email", addresses: ["a@example.com"], escalation: actionChain("https://pager.example.com/keep-going", "clear") }],
      escalation: actionChain("https://pager.example.com/stopped", "acknowledge"),
    });
    seedNotif({ acknowledged: true });
    const runs = await runEscalationSweep(NOW);
    expect(runs).toBe(1);
    expect(db.deliveries.map((d) => d.meta.url)).toEqual(["https://pager.example.com/keep-going"]);
  });

  it("a rule whose ONLY chain is per-action still enters the sweep", async () => {
    seedRule({
      actions: [{ type: "notify", channelId: "ch-email", addresses: ["a@example.com"], escalation: actionChain("https://pager.example.com/only") }],
      escalation: null,
    });
    seedNotif();
    expect(await runEscalationSweep(NOW)).toBe(1);
    expect(db.deliveries[0].meta.url).toBe("https://pager.example.com/only");
  });

  it("band severity runs the band ACTION's chain; empty band falls back to the base actions' chains", async () => {
    seedRule({
      severity: "warning",
      actions: [{ type: "notify", channelId: "ch-email", addresses: ["a@example.com"], escalation: actionChain("https://pager.example.com/base-action") }],
      escalation: null,
      severityBands: [
        { threshold: 90, severity: "serious", actions: [] }, // empty → base fallback
        { threshold: 95, severity: "critical", actions: [{ type: "api_call", method: "POST", url: "https://x.example.com", timeoutSec: 15, escalation: actionChain("https://pager.example.com/band-action") }] },
      ],
    });
    seedNotif({ severity: "critical" });
    expect(await runEscalationSweep(NOW)).toBe(1);
    expect(db.deliveries[0].meta.url).toBe("https://pager.example.com/band-action");

    db.deliveries.length = 0;
    db.notifUpdates.length = 0;
    db.notifs[0].severity = "serious";
    db.notifs[0].escalationState = null;
    expect(await runEscalationSweep(NOW)).toBe(1);
    expect(db.deliveries[0].meta.url).toBe("https://pager.example.com/base-action");
  });
});

describe("tierIsDue (unchanged semantics)", () => {
  const tier = { afterMin: 30, repeatEveryMin: 60, maxRepeats: 2 };
  it("first send after afterMin, repeats per repeatEveryMin, capped at maxRepeats", () => {
    const t0 = new Date("2026-07-21T00:00:00Z");
    expect(tierIsDue(tier, t0, undefined, new Date(t0.getTime() + 29 * 60_000))).toBe(false);
    expect(tierIsDue(tier, t0, undefined, new Date(t0.getTime() + 31 * 60_000))).toBe(true);
    const sent = { firstSentAt: new Date(t0.getTime() + 31 * 60_000).toISOString(), lastSentAt: new Date(t0.getTime() + 31 * 60_000).toISOString(), count: 1 };
    expect(tierIsDue(tier, t0, sent, new Date(t0.getTime() + 60 * 60_000))).toBe(false);
    expect(tierIsDue(tier, t0, sent, new Date(t0.getTime() + 92 * 60_000))).toBe(true);
    expect(tierIsDue(tier, t0, { ...sent, count: 2 }, new Date(t0.getTime() + 300 * 60_000))).toBe(false);
  });
});
