/**
 * tests/unit/skipUnusedPorts.test.ts
 *
 * "Skip unused ports" and the remembered address behind it
 * (AssetInterface.lastLearnedIp).
 *
 * The case (2026-09-28): a FortiGate deployment template enables wan1 AND wan2
 * on every gate, both SD-WAN members, whether or not the site has a second
 * circuit. An unplugged wan2 is down on every health check forever, so a
 * "member is down" automation pages about it on every gate that has one. The
 * unused port reads 0.0.0.0 — but so does a working DHCP WAN whose link just
 * dropped, so the CURRENT address cannot tell them apart. The port's
 * REMEMBERED address can: the unused port never had one, the failed WAN did.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  prisma: {
    notificationRule: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    notificationRuleState: { findMany: vi.fn(), update: vi.fn(), upsert: vi.fn(), findUnique: vi.fn(), deleteMany: vi.fn(), delete: vi.fn() },
    notification: { create: vi.fn(), updateMany: vi.fn() },
    asset: { findMany: vi.fn(), findUnique: vi.fn() },
    assetTelemetrySample: { findMany: vi.fn() },
    assetInterfaceSample: { findMany: vi.fn() },
    assetInterface: { findMany: vi.fn() },
    assetIpsecTunnelSample: { findMany: vi.fn() },
    assetPerfSlaSample: { findMany: vi.fn() },
    event: { findMany: vi.fn() },
    setting: { findUnique: vi.fn(), upsert: vi.fn() },
    hostMetricsSample: { findMany: vi.fn() },
  },
}));

vi.mock("../../src/db.js", () => ({ prisma: h.prisma }));
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: vi.fn(async () => {}) }));
vi.mock("../../src/services/notificationRecipientService.js", () => ({
  expandDeliveries: vi.fn(async () => {}),
  scopeRegionTagsOf: vi.fn(() => []),
}));

import { evaluateAllNotificationRules } from "../../src/services/notificationEngine.js";
import {
  isUnusedPort,
  nextLastLearnedIp,
  LAST_LEARNED_IP_TTL_MS,
} from "../../src/services/interfaceInventoryService.js";
import {
  buildSchemaCatalog,
  ruleInputSchema,
  triggerSignature,
  SKIP_UNUSED_PORT_TARGETS,
} from "../../src/services/notificationTypes.js";

const DAY = 86_400_000;
const NOW = new Date();

function gate(id: string, over: Partial<Record<string, unknown>> = {}) {
  return {
    id, hostname: id.toUpperCase(), assetType: "firewall", tags: [], discoveredByIntegrationId: null,
    monitorStatus: "up", status: "active", consecutiveFailures: 0, dependencySuppressed: false,
    quarantinedAt: null, ipAddress: null, manufacturer: null, model: null, os: null,
    monitoredInterfaces: [] as string[],
    ...over,
  };
}

const sla = (link: string, over: Partial<Record<string, unknown>> = {}) => ({
  assetId: "fw1", healthCheck: "Primary WAN", link, timestamp: new Date(),
  state: "down", latencyMs: null, jitterMs: null, packetLoss: 100, ...over,
});

/** A current-state interface row, as dropUnusedPorts selects it. */
const iface = (ifName: string, over: Partial<Record<string, unknown>> = {}) => ({
  assetId: "fw1", ifName, ifType: "physical", ipAddress: "0.0.0.0", lastLearnedIp: null, lastLearnedIpAt: null, ...over,
});

const RULE = {
  id: "r1", name: "SD-WAN member down", description: null, enabled: true, severity: "serious",
  trigger: { type: "asset_state", field: "sdwanMemberState", operator: "!=", value: "up", forDurationSec: 0, skipUnusedPorts: true },
  scope: { allAssets: true }, reset: { mode: "auto" }, actions: [], clearBehavior: "auto",
  clearAfterSec: null, cooldownSec: null, messageTemplate: null, channels: ["in_app"], targets: [],
  emailComposition: null, escalation: null, severityBands: null, bandNotify: null,
};

const firedDimensions = () =>
  h.prisma.notification.create.mock.calls.map(([args]: any[]) => args.data.dimension).sort();

beforeEach(() => {
  vi.clearAllMocks();
  h.prisma.notificationRuleState.findMany.mockResolvedValue([]);
  h.prisma.notification.create.mockResolvedValue({ id: "n-new" });
  h.prisma.notification.updateMany.mockResolvedValue({ count: 1 });
  h.prisma.setting.findUnique.mockResolvedValue(null);
  h.prisma.event.findMany.mockResolvedValue([]);
  h.prisma.asset.findMany.mockResolvedValue([gate("fw1")]);
  h.prisma.assetTelemetrySample.findMany.mockResolvedValue([]);
  h.prisma.assetInterfaceSample.findMany.mockResolvedValue([]);
  h.prisma.assetInterface.findMany.mockResolvedValue([]);
  h.prisma.assetIpsecTunnelSample.findMany.mockResolvedValue([]);
  h.prisma.assetPerfSlaSample.findMany.mockResolvedValue([]);
});

describe("the remembered address", () => {
  it("learns an address the moment the port reports one, without its mask", () => {
    expect(nextLastLearnedIp(undefined, "203.0.113.10/29", NOW)).toEqual({ lastLearnedIp: "203.0.113.10", lastLearnedIpAt: NOW });
    expect(nextLastLearnedIp(undefined, "10.4.1.1 255.255.255.0", NOW).lastLearnedIp).toBe("10.4.1.1");
  });

  it("keeps it through 0.0.0.0 — a DHCP WAN that lost its lease is not an unused port", () => {
    const at = new Date(NOW.getTime() - 2 * DAY);
    expect(nextLastLearnedIp({ ip: "203.0.113.10", at }, "0.0.0.0", NOW)).toEqual({ lastLearnedIp: "203.0.113.10", lastLearnedIpAt: at });
    expect(nextLastLearnedIp({ ip: "203.0.113.10", at }, "0.0.0.0 0.0.0.0", NOW).lastLearnedIp).toBe("203.0.113.10");
    // A pass that collected no address at all says nothing either way.
    expect(nextLastLearnedIp({ ip: "203.0.113.10", at }, null, NOW).lastLearnedIp).toBe("203.0.113.10");
  });

  it("forgets it after 30 days without an address", () => {
    const old = new Date(NOW.getTime() - LAST_LEARNED_IP_TTL_MS - 1);
    expect(nextLastLearnedIp({ ip: "203.0.113.10", at: old }, "0.0.0.0", NOW)).toEqual({ lastLearnedIp: null, lastLearnedIpAt: null });
  });

  it("never invents one for a port that was never addressed", () => {
    expect(nextLastLearnedIp(undefined, "0.0.0.0", NOW)).toEqual({ lastLearnedIp: null, lastLearnedIpAt: null });
  });
});

describe("what counts as an unused port", () => {
  it("is a non-tunnel port at 0.0.0.0 with nothing remembered", () => {
    expect(isUnusedPort(iface("wan2"), NOW)).toBe(true);
    expect(isUnusedPort(iface("wan2", { ipAddress: "0.0.0.0 0.0.0.0" }), NOW)).toBe(true);
  });

  it("is never a port that had an address in the last 30 days", () => {
    expect(isUnusedPort(iface("wan1", { lastLearnedIp: "203.0.113.10", lastLearnedIpAt: new Date(NOW.getTime() - 5 * DAY) }), NOW)).toBe(false);
    expect(isUnusedPort(iface("wan1", { lastLearnedIp: "203.0.113.10", lastLearnedIpAt: new Date(NOW.getTime() - 31 * DAY) }), NOW)).toBe(true);
  });

  it("is never a port that has an address now, reports none at all, or is a tunnel", () => {
    expect(isUnusedPort(iface("wan1", { ipAddress: "203.0.113.10" }), NOW)).toBe(false);
    expect(isUnusedPort(iface("wan1", { ipAddress: null }), NOW)).toBe(false);
    expect(isUnusedPort(iface("Overlay-1", { ifType: "tunnel" }), NOW)).toBe(false);
  });
});

describe("skip unused ports on SD-WAN member state", () => {
  it("drops the template's unplugged wan2 and keeps a DHCP WAN that just lost its lease", async () => {
    h.prisma.notificationRule.findMany.mockResolvedValue([RULE]);
    h.prisma.assetPerfSlaSample.findMany.mockResolvedValue([sla("wan1"), sla("wan2"), sla("Overlay-1")]);
    h.prisma.assetInterface.findMany.mockResolvedValue([
      // Down now, but had a lease two days ago — a real outage.
      iface("wan1", { lastLearnedIp: "203.0.113.10", lastLearnedIpAt: new Date(NOW.getTime() - 2 * DAY) }),
      // Never connected.
      iface("wan2"),
      // The IPsec overlay: a tunnel, never skipped.
      iface("Overlay-1", { ifType: "tunnel" }),
    ]);

    await evaluateAllNotificationRules();

    expect(firedDimensions()).toEqual(["Primary WAN|Overlay-1", "Primary WAN|wan1"]);
    // One read, narrowed to the gate and the member names in play.
    const where = h.prisma.assetInterface.findMany.mock.calls[0]![0].where;
    expect(where.assetId.in).toEqual(["fw1"]);
    expect(where.ifName.in.sort()).toEqual(["Overlay-1", "wan1", "wan2"]);
  });

  it("keeps a member it knows nothing about — no interface row", async () => {
    h.prisma.notificationRule.findMany.mockResolvedValue([RULE]);
    h.prisma.assetPerfSlaSample.findMany.mockResolvedValue([sla("wan3")]);
    await evaluateAllNotificationRules();
    expect(firedDimensions()).toEqual(["Primary WAN|wan3"]);
  });

  it("changes nothing, and reads nothing, when the option is off", async () => {
    h.prisma.notificationRule.findMany.mockResolvedValue([{ ...RULE, trigger: { ...RULE.trigger, skipUnusedPorts: undefined } }]);
    h.prisma.assetPerfSlaSample.findMany.mockResolvedValue([sla("wan1"), sla("wan2")]);
    h.prisma.assetInterface.findMany.mockResolvedValue([iface("wan2")]);
    await evaluateAllNotificationRules();
    expect(firedDimensions()).toEqual(["Primary WAN|wan1", "Primary WAN|wan2"]);
    expect(h.prisma.assetInterface.findMany).not.toHaveBeenCalled();
  });

  it("keeps every member when the lookup fails", async () => {
    h.prisma.notificationRule.findMany.mockResolvedValue([RULE]);
    h.prisma.assetPerfSlaSample.findMany.mockResolvedValue([sla("wan2")]);
    h.prisma.assetInterface.findMany.mockRejectedValue(new Error("db gone"));
    await evaluateAllNotificationRules();
    expect(firedDimensions()).toEqual(["Primary WAN|wan2"]);
  });
});

describe("skip unused ports on the SD-WAN metrics and interface oper status", () => {
  it("drops an unused member from a packet-loss automation", async () => {
    h.prisma.notificationRule.findMany.mockResolvedValue([{
      ...RULE,
      trigger: { type: "asset_metric", metric: "sdwanPacketLoss", aggregation: "latest", windowSec: 0, operator: ">=", threshold: 50, forDurationSec: 0, skipUnusedPorts: true },
    }]);
    h.prisma.assetPerfSlaSample.findMany.mockResolvedValue([sla("wan1"), sla("wan2")]);
    h.prisma.assetInterface.findMany.mockResolvedValue([iface("wan2"), iface("wan1", { ipAddress: "203.0.113.10" })]);
    await evaluateAllNotificationRules();
    expect(firedDimensions()).toEqual(["Primary WAN|wan1"]);
  });

  it("drops an unused pinned interface from an oper-status automation", async () => {
    h.prisma.notificationRule.findMany.mockResolvedValue([{
      ...RULE,
      trigger: { type: "asset_state", field: "ifOperStatus", operator: "==", value: "down", forDurationSec: 0, skipUnusedPorts: true },
    }]);
    h.prisma.asset.findMany.mockResolvedValue([gate("fw1", { monitoredInterfaces: ["wan1", "wan2"] })]);
    const row = (ifName: string) => ({ assetId: "fw1", ifName, alias: null, timestamp: new Date(), operStatus: "down", adminStatus: "up", poeStatus: null, ipAddress: "0.0.0.0" });
    h.prisma.assetInterfaceSample.findMany.mockResolvedValue([row("wan1"), row("wan2")]);
    h.prisma.assetInterface.findMany.mockResolvedValue([
      iface("wan1", { lastLearnedIp: "198.51.100.7", lastLearnedIpAt: new Date(NOW.getTime() - DAY) }),
      iface("wan2"),
    ]);
    await evaluateAllNotificationRules();
    expect(firedDimensions()).toEqual(["wan1"]);
  });
});

describe("the option's vocabulary", () => {
  const base = { name: "x", severity: "serious", scope: { allAssets: true }, messageTemplate: "{message}" };

  it("is offered on the conditions that name a port, and published to the builder", () => {
    expect([...SKIP_UNUSED_PORT_TARGETS].sort()).toEqual(["ifOperStatus", "sdwanJitterMs", "sdwanLatencyMs", "sdwanMemberState", "sdwanPacketLoss"]);
    expect((buildSchemaCatalog().skipUnusedPortTargets as string[]).sort()).toEqual([...SKIP_UNUSED_PORT_TARGETS].sort());
  });

  it("saves on a supported condition", () => {
    expect(() => ruleInputSchema.parse({ ...base, trigger: { type: "asset_state", field: "sdwanMemberState", operator: "!=", value: "up", skipUnusedPorts: true } })).not.toThrow();
    expect(() => ruleInputSchema.parse({ ...base, trigger: { type: "asset_metric", metric: "sdwanLatencyMs", operator: ">=", threshold: 150, skipUnusedPorts: true } })).not.toThrow();
  });

  it("is refused anywhere it would silently filter nothing", () => {
    expect(() => ruleInputSchema.parse({ ...base, trigger: { type: "asset_metric", metric: "cpuPct", operator: ">=", threshold: 90, skipUnusedPorts: true } })).toThrow(/skipping unused ports/);
    expect(() => ruleInputSchema.parse({
      ...base,
      trigger: {
        type: "composite", kind: "asset", op: "and",
        children: [
          { type: "asset_state", field: "sdwanMemberState", operator: "!=", value: "up" },
          { type: "asset_state", field: "ifIpAddress", operator: "!=", value: "0.0.0.0", skipUnusedPorts: true },
        ],
      },
    })).toThrow(/skipping unused ports/);
  });

  it("keeps an automation that skips unused ports from carving out one that does not", () => {
    const plain = { type: "asset_state", field: "sdwanMemberState", operator: "!=", value: "up", forDurationSec: 0 } as const;
    expect(triggerSignature({ ...plain, skipUnusedPorts: true } as never)).not.toBe(triggerSignature(plain as never));
  });
});
