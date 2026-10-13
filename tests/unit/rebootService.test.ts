/**
 * tests/unit/rebootService.test.ts — who may reboot what, and what a reboot
 * run takes as proof (business rule 115).
 *
 * The availability half pins the OPT-IN: nothing reboots a device unless a
 * stored credential with Allow reboots, the discovering integration with Allow
 * reboots, or an agent host's own opt-in covers it — in that order — and an
 * HA FortiGate is refused while its managed switches are not. The runner half
 * drives `startReboot` against a fake gate (the transport seam) with
 * millisecond clocks: a run is `succeeded` only on proof the device cycled,
 * a mismatched serial or a live HA mode never reaches the reboot call, and an
 * agent that never picks the command up has it WITHDRAWN so it cannot fire
 * later.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => {
  const state = {
    asset: null as Record<string, unknown> | null,
    gates: [] as Array<Record<string, unknown>>,
    integration: null as Record<string, unknown> | null,
    credentials: [] as Array<Record<string, unknown>>,
    binding: null as Record<string, unknown> | null,
    flashRunning: false,
    activeRun: null as Record<string, unknown> | null,
    runUpdates: [] as Array<Record<string, unknown>>,
    created: null as Record<string, unknown> | null,
    agentCmd: null as Record<string, unknown> | null,
    agentCmdStatus: "pending",
    withdrawn: 0,
    agentRow: { bootTime: null as Date | null, wsConnectedAt: null as Date | null, wsDisconnectedAt: null as Date | null },
    lastRebootAt: null as Date | null,
    order: [] as string[],
  };
  return {
    state,
    openMaintenanceHold: vi.fn(async () => { state.order.push("hold"); return true; }),
    releaseMaintenanceHold: vi.fn(async () => { state.order.push("release"); return true; }),
    logEvent: vi.fn(async (e: { action: string }) => { state.order.push(e.action); }),
    gate: null as unknown,
  };
});

const fullAsset = (over: Record<string, unknown> = {}) => ({
  id: "asset-1", hostname: "SPK2", ipAddress: "172.22.128.104", dnsName: null, serialNumber: "FGT61FTK23002895",
  manufacturer: "Fortinet", assetType: "firewall", model: "FGT61F", status: "active", monitored: true,
  fortinetTopology: { role: "fortigate", deviceName: "SPK2" }, discoveredByIntegrationId: "int-1", lastRebootAt: null,
  monitorCredentialId: null, responseTimeCredentialId: null, cpuMemoryCredentialId: null, temperatureCredentialId: null,
  interfacesCredentialId: null, lldpCredentialId: null, customWidgetCredentialId: null, processesCredentialId: null, eventLogCredentialId: null,
  managedAgent: null,
  ...over,
});

vi.mock("../../src/db.js", () => ({
  prisma: {
    asset: {
      findUnique: vi.fn(async (args: { select?: Record<string, unknown> }) =>
        args.select && Object.keys(args.select).length === 1 && "lastRebootAt" in args.select ? { lastRebootAt: h.state.lastRebootAt } : h.state.asset),
      findMany: vi.fn(async () => h.state.gates),
    },
    integration: { findUnique: vi.fn(async () => h.state.integration) },
    credential: { findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => h.state.credentials.filter((c) => where.id.in.includes(c.id as string))) },
    firmwareUpgradeRun: { findFirst: vi.fn(async () => (h.state.flashRunning ? { id: "fw-1" } : null)) },
    rebootRun: {
      findFirst: vi.fn(async (args: { where: { status: { in?: string[] } } }) => (args.where.status.in ? h.state.activeRun : null)),
      findMany: vi.fn(async () => []),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: "run-1", stage: null, error: null, startedAt: new Date(), finishedAt: null, heartbeatAt: null, ...data };
        h.state.created = row;
        return row;
      }),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { h.state.runUpdates.push(data); return {}; }),
    },
    // findMany: a reboot-now that succeeds looks for a booking to withdraw (rule 115(b)).
    rebootSchedule: { update: vi.fn(async () => ({})), findMany: vi.fn(async () => []) },
    agentCommand: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { h.state.agentCmd = data; return { id: "cmd-1", ...data }; }),
      findUnique: vi.fn(async () => ({ status: h.state.agentCmdStatus, error: h.state.agentCmdStatus === "failed" ? "not enabled" : null })),
      updateMany: vi.fn(async () => { h.state.withdrawn++; return { count: h.state.agentCmdStatus === "pending" ? 1 : 0 }; }),
    },
    managedAgent: { findUnique: vi.fn(async () => h.state.agentRow) },
  },
}));

vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: h.logEvent }));
const recordCredentialUse = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../../src/services/credentialUseAuditService.js", () => ({ recordCredentialUse }));
vi.mock("../../src/services/maintenanceScheduleService.js", () => ({
  openMaintenanceHold: h.openMaintenanceHold,
  releaseMaintenanceHold: h.releaseMaintenanceHold,
}));
vi.mock("../../src/services/holdRecoveryWait.js", () => ({ holdUntilMonitorAnswers: vi.fn(async () => true) }));
vi.mock("../../src/services/agentCommandWake.js", () => ({ publishCommandWake: vi.fn(async () => undefined) }));
vi.mock("../../src/services/firmwareRepositoryService.js", () => ({ resolveFirmwareCredential: vi.fn(async () => h.state.binding) }));
vi.mock("../../src/services/reservationPushService.js", () => ({
  buildTransportForIntegration: vi.fn(async () => ({ kind: "direct-fortigate", fgConfig: { host: "172.22.128.104", port: 443, apiToken: "tok", verifySsl: false }, vdom: "root" })),
}));
vi.mock("../../src/services/credentialService.js", async (orig) => {
  const real = await orig<typeof import("../../src/services/credentialService.js")>();
  return {
    ...real,
    getCredential: vi.fn(async (id: string) => {
      const c = h.state.credentials.find((x) => x.id === id);
      if (!c) throw new Error("not found");
      return c;
    }),
  };
});
vi.mock("../../src/services/rebootTransports.js", async (orig) => {
  const real = await orig<typeof import("../../src/services/rebootTransports.js")>();
  return { ...real, _rebootTransportSeams: { gateOps: () => h.gate, tcpUp: async () => false } };
});

import { getRebootAvailability, startReboot, recordRebootCredentialUse } from "../../src/services/rebootService.js";
import { RebootSendError } from "../../src/services/rebootTransports.js";

const FAST = { overrides: { timeouts: { agentAckMs: 60, downWaitMs: 60, upWaitMs: 200, pollMs: 2, recoveryWaitMs: 1, recoveryPollMs: 1 } } };

async function settled(): Promise<Record<string, unknown>> {
  for (let i = 0; i < 400; i++) {
    const last = h.state.runUpdates.find((u) => ["succeeded", "failed", "unverified"].includes(String(u.status)));
    if (last) return last;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("run never finished");
}

function fakeGate(over: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const g = {
    label: "fake gate",
    calls,
    serial: vi.fn(async () => "FGT61FTK23002895"),
    haMode: vi.fn(async () => "standalone"),
    bootTime: vi.fn(async () => new Date("2026-10-01T00:00:00Z")),
    managedSwitches: vi.fn(async () => null),
    managedAps: vi.fn(async () => null),
    rebootSelf: vi.fn(async () => { calls.push("rebootSelf"); return {}; }),
    restartSwitch: vi.fn(async (id: string) => { calls.push(`restartSwitch:${id}`); return {}; }),
    restartAp: vi.fn(async (id: string) => { calls.push(`restartAp:${id}`); return {}; }),
    close: vi.fn(async () => undefined),
    ...over,
  };
  h.gate = g;
  return g;
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(h.state, {
    asset: fullAsset(), gates: [], credentials: [], binding: null, flashRunning: false, activeRun: null,
    integration: { id: "int-1", name: "lab-spoke2", type: "fortigate", config: { host: "172.22.128.104", apiToken: "tok", allowReboot: true } },
    runUpdates: [], created: null, agentCmd: null, agentCmdStatus: "pending", withdrawn: 0, lastRebootAt: null, order: [],
    agentRow: { bootTime: null, wsConnectedAt: null, wsDisconnectedAt: null },
  });
});

describe("who may reboot what (availability)", () => {
  it("offers nothing for an asset that is neither Fortinet infrastructure nor an agent host", async () => {
    h.state.asset = fullAsset({ manufacturer: "Dell", assetType: "server" });
    const r = await getRebootAvailability("asset-1");
    expect(r.state).toBe("unsupported");
    expect(r.kind).toBeNull();
  });

  it("refuses an HA FortiGate", async () => {
    h.state.asset = fullAsset({ fortinetTopology: { role: "fortigate", haMode: "a-p", haRole: "primary" } });
    const r = await getRebootAvailability("asset-1");
    expect(r.state).toBe("ha");
    expect(r.available).toBe(false);
  });

  it("says no-credential, naming the integration toggle, when nothing opted in", async () => {
    h.state.integration = { id: "int-1", name: "lab-spoke2", type: "fortigate", config: { host: "h", apiToken: "tok" } };
    const r = await getRebootAvailability("asset-1");
    expect(r.state).toBe("no-credential");
    expect(r.reason).toMatch(/"Allow reboots" is off on the lab-spoke2 integration/);
  });

  it("uses the integration's token when the integration allows reboots", async () => {
    const r = await getRebootAvailability("asset-1");
    expect(r).toMatchObject({ state: "available", available: true, method: "fortigate-rest", authority: "Integration API token (lab-spoke2)" });
  });

  it("prefers a stored credential with Allow reboots over the integration, and skips one without it", async () => {
    h.state.asset = fullAsset({ monitorCredentialId: "c-snmp-ish", cpuMemoryCredentialId: "c-ssh" });
    h.state.credentials = [
      { id: "c-snmp-ish", name: "ro token", type: "restapi", config: { baseUrl: "https://x", apiToken: "t" } },
      { id: "c-ssh", name: "lab ssh", type: "ssh", config: { username: "a", password: "p", allowReboot: true } },
    ];
    const r = await getRebootAvailability("asset-1");
    expect(r).toMatchObject({ state: "available", method: "fortigate-ssh", authority: "lab ssh" });
  });

  it("restarts a managed FortiSwitch through its gate even when the gate is an HA member", async () => {
    h.state.asset = fullAsset({
      id: "sw-1", hostname: "S248EFTF20002731", serialNumber: "S248EFTF20002731", assetType: "switch",
      fortinetTopology: { role: "fortiswitch", controllerFortigate: "HUB1-a", controllerSerial: "FGT61FTK23009069" },
    });
    h.state.gates = [fullAsset({ id: "gate-1", hostname: "HUB1-a", serialNumber: "FGT61FTK23009069", fortinetTopology: { role: "fortigate", haMode: "a-p" } })];
    const r = await getRebootAvailability("sw-1");
    expect(r).toMatchObject({ state: "available", method: "controller-switch", via: { assetId: "gate-1", label: "HUB1-a" } });
  });

  it("blocks a reboot while a firmware flash runs on the device", async () => {
    h.state.flashRunning = true;
    const r = await getRebootAvailability("asset-1");
    expect(r.state).toBe("blocked");
    expect(r.reason).toMatch(/firmware upgrade is running/);
  });

  describe("an agent host", () => {
    const agent = (over: Record<string, unknown> = {}) => fullAsset({
      manufacturer: "Dell", assetType: "server", fortinetTopology: null,
      managedAgent: { id: "ma-1", installStatus: "active", agentVersion: "0.26.0", osPlatform: "linux", rebootEnabled: true, rebootCapable: true, bootTime: null, lastSeenAt: new Date(), ...over },
    });
    it("is off until the host opted in", async () => {
      h.state.asset = agent({ rebootEnabled: false });
      expect((await getRebootAvailability("asset-1")).state).toBe("agent-disabled");
    });
    it("needs an agent that knows the command", async () => {
      h.state.asset = agent({ agentVersion: "0.25.0" });
      expect((await getRebootAvailability("asset-1")).state).toBe("agent-too-old");
    });
    it("waits for the host to confirm it can", async () => {
      h.state.asset = agent({ rebootCapable: null });
      expect((await getRebootAvailability("asset-1")).state).toBe("agent-incapable");
    });
    it("refuses an agent not heard from recently", async () => {
      h.state.asset = agent({ lastSeenAt: new Date(Date.now() - 3600_000) });
      expect((await getRebootAvailability("asset-1")).state).toBe("agent-offline");
    });
    it("is available when opted in, capable and current", async () => {
      h.state.asset = agent();
      expect(await getRebootAvailability("asset-1")).toMatchObject({ state: "available", kind: "agent", method: "agent", authority: "Polaris Agent" });
    });
  });
});

describe("the credential a reboot signs with is recorded (rule 112)", () => {
  const actor = { username: "alice", actor: "alice", mayUseAny: false };
  it("records a stored credential, aimed at the gate's address", async () => {
    h.state.asset = fullAsset({ cpuMemoryCredentialId: "c-ssh" });
    h.state.credentials = [{ id: "c-ssh", name: "lab ssh", type: "ssh", config: { username: "a", password: "p", allowReboot: true } }];
    await recordRebootCredentialUse("asset-1", actor);
    expect(recordCredentialUse).toHaveBeenCalledWith(actor, "device.reboot", [expect.objectContaining({ credentialId: "c-ssh", destination: "172.22.128.104", assetId: "asset-1" })]);
  });
  it("records nothing for the integration's own token", async () => {
    await recordRebootCredentialUse("asset-1", actor);
    expect(recordCredentialUse).not.toHaveBeenCalled();
  });
});

describe("a reboot run", () => {
  it("succeeds only once the gate reports a newer boot time, holding before and releasing before the terminal Event", async () => {
    let n = 0;
    const g = fakeGate({
      bootTime: vi.fn(async () => {
        n++;
        if (n === 1) return new Date("2026-10-01T00:00:00Z");
        if (n === 2) throw new Error("fetch failed");
        return new Date();
      }),
    });
    await startReboot({ assetId: "asset-1", actor: "alice", ...FAST });
    const last = await settled();
    expect(last.status).toBe("succeeded");
    expect(g.calls).toEqual(["rebootSelf"]);
    expect(h.state.created).toMatchObject({ method: "fortigate-rest", authority: "Integration API token (lab-spoke2)", startedBy: "alice" });
    const o = h.state.order;
    expect(o.indexOf("asset.reboot_started")).toBeLessThan(o.indexOf("hold"));
    expect(o.indexOf("release")).toBeLessThan(o.indexOf("asset.reboot_succeeded"));
  });

  it("never sends the reboot to a device whose serial is not the asset's", async () => {
    const g = fakeGate({ serial: vi.fn(async () => "FGT61FTK99999999") });
    await startReboot({ assetId: "asset-1", actor: "alice", ...FAST });
    const last = await settled();
    expect(last.status).toBe("failed");
    expect(String(last.error)).toMatch(/not this asset/);
    expect(g.calls).toEqual([]);
  });

  it("refuses at run time a gate that has joined an HA cluster since discovery", async () => {
    const g = fakeGate({ haMode: vi.fn(async () => "a-p") });
    await startReboot({ assetId: "asset-1", actor: "alice", ...FAST });
    expect((await settled()).status).toBe("failed");
    expect(g.calls).toEqual([]);
  });

  it("records a clear refusal from the gate as a failed run", async () => {
    fakeGate({ rebootSelf: vi.fn(async () => { throw new RebootSendError("permission denied (HTTP 403)"); }) });
    await startReboot({ assetId: "asset-1", actor: "alice", ...FAST });
    const last = await settled();
    expect(last.status).toBe("failed");
    expect(String(last.error)).toMatch(/403/);
    expect(h.logEvent).toHaveBeenCalledWith(expect.objectContaining({ action: "asset.reboot_failed", level: "warning" }));
  });

  it("is unverified when the device accepted but never went down", async () => {
    fakeGate();
    await startReboot({ assetId: "asset-1", actor: "alice", ...FAST });
    const last = await settled();
    expect(last.status).toBe("unverified");
    expect(h.logEvent).toHaveBeenCalledWith(expect.objectContaining({ action: "asset.reboot_unverified" }));
  });

  it("restarts a managed switch by the name its gate gives it, and proves it by the drop and rejoin", async () => {
    h.state.asset = fullAsset({
      id: "sw-1", hostname: "S248EFTF20002731", serialNumber: "S248EFTF20002731", assetType: "switch",
      fortinetTopology: { role: "fortiswitch", controllerFortigate: "HUB1-a", controllerSerial: "FGT61FTK23009069" },
    });
    h.state.gates = [fullAsset({ id: "gate-1", hostname: "HUB1-a", serialNumber: "FGT61FTK23009069" })];
    let n = 0;
    const g = fakeGate({
      managedSwitches: vi.fn(async () => {
        n++;
        const status = n === 2 ? "Disconnected" : "Connected";
        return [{ serial: "S248EFTF20002731", switchId: "IDF-1", status, joinTime: n >= 3 ? 2000 : 1000 }];
      }),
    });
    await startReboot({ assetId: "sw-1", actor: "alice", ...FAST });
    expect((await settled()).status).toBe("succeeded");
    expect(g.calls).toEqual(["restartSwitch:IDF-1"]);
    expect(h.state.created).toMatchObject({ method: "controller-switch", viaAssetId: "gate-1" });
  });

  it("refuses a switch its gate no longer lists", async () => {
    h.state.asset = fullAsset({ id: "sw-1", serialNumber: "S248EFTF20002731", assetType: "switch", fortinetTopology: { controllerFortigate: "HUB1-a" } });
    h.state.gates = [fullAsset({ id: "gate-1", hostname: "HUB1-a" })];
    const g = fakeGate({ managedSwitches: vi.fn(async () => [{ serial: "OTHER", switchId: "X", status: "Connected", joinTime: 1 }]) });
    await startReboot({ assetId: "sw-1", actor: "alice", ...FAST });
    const last = await settled();
    expect(last.status).toBe("failed");
    expect(String(last.error)).toMatch(/does not list/);
    expect(g.calls).toEqual([]);
  });

  describe("on an agent host", () => {
    beforeEach(() => {
      h.state.asset = fullAsset({
        manufacturer: "Dell", assetType: "server", fortinetTopology: null,
        managedAgent: { id: "ma-1", installStatus: "active", agentVersion: "0.26.0", osPlatform: "linux", rebootEnabled: true, rebootCapable: true, bootTime: new Date("2026-10-01T00:00:00Z"), lastSeenAt: new Date() },
      });
    });

    it("queues the command, and succeeds when the agent acknowledges and reports a new boot time", async () => {
      h.state.agentCmdStatus = "succeeded";
      h.state.agentRow = { bootTime: new Date(), wsConnectedAt: new Date(), wsDisconnectedAt: null };
      await startReboot({ assetId: "asset-1", actor: "alice", ...FAST });
      expect((await settled()).status).toBe("succeeded");
      expect(h.state.agentCmd).toMatchObject({ action: "reboot", managedAgentId: "ma-1" });
    });

    it("withdraws a command the agent never picked up, so it cannot fire later", async () => {
      h.state.agentCmdStatus = "pending";
      await startReboot({ assetId: "asset-1", actor: "alice", ...FAST });
      const last = await settled();
      expect(last.status).toBe("failed");
      expect(String(last.error)).toMatch(/withdrawn and will not run/);
      expect(h.state.withdrawn).toBe(1);
    });

    it("fails with the agent's own refusal", async () => {
      h.state.agentCmdStatus = "failed";
      await startReboot({ assetId: "asset-1", actor: "alice", ...FAST });
      const last = await settled();
      expect(last.status).toBe("failed");
      expect(String(last.error)).toMatch(/agent refused: not enabled/);
    });
  });
});
