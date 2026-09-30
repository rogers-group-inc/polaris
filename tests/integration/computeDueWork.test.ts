/**
 * tests/integration/computeDueWork.test.ts — the due-set computation extracted from
 * runMonitorPass. Pins the eligibility semantics the monitor tick lives by:
 * cadence due-ness, the dependency-suppression probe slowdown, the heavy-
 * cadence up-only gates, the per-method telemetry/systemInfo exclusions, the
 * fastFiltered skip-when-systemInfo-due rule, the agentless processes gating,
 * the absence of any mid-run probe acceleration, and the ICMP loss sampler's
 * uniform ICMP loss sweep (utils/lossSweep.ts).
 * Candidates are synthetic — computeDueWork touches the DB only
 * through the (cached) settings resolver -- which is why this lives in
 * tests/integration: the resolver reads the manual-tier Setting row.
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import { dbDescribe, dbReachable } from "./_helpers.js";
import { prisma } from "../../src/db.js";
import {
  computeDueWork,
  resolveMonitorSettings,
  invalidateMonitorSettingsCache,
  type MonitorPassCandidate,
  type MonitorCadence,
  LOSS_SAMPLES_MAX_PER_PASS,
} from "../../src/services/monitoringService.js";

const ALL = new Set<MonitorCadence>(["probe", "fastFiltered", "telemetry", "systemInfo", "processes", "sdwan", "lossSample"]);
const now = new Date("2026-08-06T12:00:00.000Z");

let probeSec = 60;
let sysInfoSec = 600;

function cand(over: Partial<MonitorPassCandidate> & { id?: string } = {}): MonitorPassCandidate {
  return {
    id: "cand-1",
    // Redundant against MONITOR_CANDIDATE_WHERE in production, but the loss
    // sweep's eligibility predicate EVALUATES it, so a candidate that omits
    // it excludes itself from the sweep and every assertion below reads [].
    monitored: true,
    assetType: "server",
    discoveredByIntegrationId: null,
    discoveredByIntegration: null,
    monitorStatus: "up",
    consecutiveFailures: 0,
    consecutiveSuccesses: 3,
    lastMonitorAt: null,
    monitorIntervalSec: null,
    lastTelemetryAt: null,
    cpuMemoryIntervalSec: null,
    temperatureIntervalSec: null,
    lastSystemInfoAt: null,
    systemInfoIntervalSec: null,
    probeTimeoutMs: null,
    responseTimePolling: null,
    cpuMemoryPolling: null,
    temperaturePolling: null,
    interfacesPolling: null,
    lldpPolling: null,
    storagePolling: null,
    monitoredInterfaces: [],
    monitoredStorage: [],
    monitoredIpsecTunnels: [],
    processesPolling: null,
    lastProcessesAt: null,
    lastProcessPinsAt: null,
    monitoredProcesses: [],
    mappedProcesses: [],
    lastSdwanAt: null,
    dependencySuppressed: false,
    // ICMP loss-sampler inputs. An address is required (there is nothing to
    // ping without one) and `status` gates on maintenance.
    lastLossSampleAt: null,
    ipAddress: "10.0.0.9",
    dnsName: null,
    hostname: "cand-1.example",
    status: "active",
    ...over,
  } as MonitorPassCandidate;
}

/**
 * Every asset due a status probe this tick, whichever collection it landed in.
 *
 * ICMP is published as BATCHES (one fping per timeout bucket serves the chunk)
 * while every other transport stays one work item per asset, so the due-set has
 * two halves. These tests are about the CADENCE — is this asset due? — not about
 * which half it lands in, so they ask the union. The split itself is pinned
 * separately, in "probe batching".
 */
function probeDueIds(due: { probes: Array<{ id: string }>; probeBatch: Array<{ id: string }> }): string[] {
  return [...due.probes.map((p) => p.id), ...due.probeBatch.map((p) => p.id)];
}

function ago(sec: number): Date {
  return new Date(now.getTime() - sec * 1000);
}

beforeAll(async () => {
  if (!dbReachable) return;
  // Resolve the effective defaults once so relative-timestamp tests hold
  // whatever the manual tier / hardcoded floor happens to configure.
  const eff = await resolveMonitorSettings({
    ...cand(),
    discoveredByIntegrationType: null,
  } as never);
  probeSec = eff.intervalSeconds;
  sysInfoSec = eff.systemInfoIntervalSeconds;
});

dbDescribe("computeDueWork", () => {
  it("a never-probed asset is probe-due; a freshly probed one is not", async () => {
    const due = await computeDueWork([cand()], ALL, now);
    expect(probeDueIds(due)).toEqual(["cand-1"]);

    const fresh = await computeDueWork([cand({ lastMonitorAt: now })], ALL, now);
    expect(fresh.probes).toEqual([]);
  });

  it("dependency suppression doubles the probe cadence", async () => {
    const staleBy1_5 = ago(Math.round(probeSec * 1.5));
    const normal = await computeDueWork([cand({ lastMonitorAt: staleBy1_5 })], ALL, now);
    expect(probeDueIds(normal)).toHaveLength(1);

    const suppressed = await computeDueWork(
      [cand({ lastMonitorAt: staleBy1_5, dependencySuppressed: true })], ALL, now,
    );
    expect(probeDueIds(suppressed)).toEqual([]);

    const veryStale = await computeDueWork(
      [cand({ lastMonitorAt: ago(Math.round(probeSec * 2.5)), dependencySuppressed: true })], ALL, now,
    );
    expect(probeDueIds(veryStale)).toHaveLength(1);
  });

  it("telemetry runs only for confirmed-up assets on a telemetry-capable method", async () => {
    const up = await computeDueWork([cand({ cpuMemoryPolling: "snmp" })], ALL, now);
    expect(up.telemetries).toHaveLength(1);

    const warning = await computeDueWork(
      [cand({ cpuMemoryPolling: "snmp", monitorStatus: "warning" })], ALL, now,
    );
    expect(warning.telemetries).toEqual([]);

    // ssh / winrm used to be excluded here because no collector existed;
    // agentlessHostService supplies one, so they enqueue like any other
    // transport now. icmp still carries no payload and stays out.
    const ssh = await computeDueWork([cand({ cpuMemoryPolling: "ssh" })], ALL, now);
    expect(ssh.telemetries).toHaveLength(1);
    const winrm = await computeDueWork([cand({ cpuMemoryPolling: "winrm" })], ALL, now);
    expect(winrm.telemetries).toHaveLength(1);
    const icmp = await computeDueWork([cand({ cpuMemoryPolling: "icmp" })], ALL, now);
    expect(icmp.telemetries).toEqual([]);

    // Managed FortiSwitch on REST has no direct telemetry endpoint…
    const restSwitch = await computeDueWork(
      [cand({ cpuMemoryPolling: "rest_api", assetType: "switch" })], ALL, now,
    );
    expect(restSwitch.telemetries).toEqual([]);
    // …but a managed FortiAP on REST does (managed_ap piggyback).
    const restAp = await computeDueWork(
      [cand({ cpuMemoryPolling: "rest_api", assetType: "access_point" })], ALL, now,
    );
    expect(restAp.telemetries).toHaveLength(1);
  });

  it("systemInfo excludes the REST + managed-switch/AP combination", async () => {
    const snmp = await computeDueWork([cand({ interfacesPolling: "snmp" })], ALL, now);
    expect(snmp.systemInfos).toHaveLength(1);

    const restSwitch = await computeDueWork(
      [cand({ interfacesPolling: "rest_api", assetType: "switch" })], ALL, now,
    );
    expect(restSwitch.systemInfos).toEqual([]);
  });

  it("fastFiltered rides the probe cadence but yields to a due systemInfo pass", async () => {
    const base = {
      interfacesPolling: "snmp" as const,
      monitoredInterfaces: ["port1"],
      lastMonitorAt: null,          // probe due
      lastSystemInfoAt: now,        // systemInfo NOT due
    };
    const rides = await computeDueWork([cand(base)], ALL, now);
    expect(rides.fastFiltereds).toHaveLength(1);

    // When the full pass is also due, the pinned scrape is skipped.
    const yields = await computeDueWork(
      [cand({ ...base, lastSystemInfoAt: ago(sysInfoSec * 2) })], ALL, now,
    );
    expect(yields.fastFiltereds).toEqual([]);
    expect(yields.systemInfos).toHaveLength(1);
  });

  it("agentless processes dispatch only for ssh/winrm, with the pinned sub-pass path", async () => {
    const ssh = await computeDueWork([cand({ processesPolling: "ssh" })], ALL, now);
    expect(ssh.processesWork).toHaveLength(1);

    const agent = await computeDueWork([cand({ processesPolling: "agent" })], ALL, now);
    expect(agent.processesWork).toEqual([]);

    // Inventory fresh, but a pinned program owes the 60s sub-pass.
    const subPass = await computeDueWork(
      [cand({ processesPolling: "winrm", lastProcessesAt: now, monitoredProcesses: ["postgres"], lastProcessPinsAt: null })],
      ALL, now,
    );
    expect(subPass.processesWork).toHaveLength(1);

    // No pins + fresh inventory → nothing owed.
    const idle = await computeDueWork(
      [cand({ processesPolling: "winrm", lastProcessesAt: now })], ALL, now,
    );
    expect(idle.processesWork).toEqual([]);
  });

  it("the enabled-cadence set filters what is emitted", async () => {
    const probeOnly = await computeDueWork(
      [cand({ cpuMemoryPolling: "snmp", interfacesPolling: "snmp", processesPolling: "ssh" })],
      new Set<MonitorCadence>(["probe"]),
      now,
    );
    expect(probeDueIds(probeOnly)).toHaveLength(1);
    expect(probeOnly.telemetries).toEqual([]);
    expect(probeOnly.systemInfos).toEqual([]);
    expect(probeOnly.processesWork).toEqual([]);
  });
});

// ─── No confirmation acceleration (business rule 30) ─────────────────────────
// The fast-confirm re-probe was removed 2026-08-19: `down` is now
// `failureThreshold` misses of the configured transport at the configured
// cadence, full stop. These pin that computeDueWork does NOT accelerate a
// mid-run asset — reintroducing it here would silently change what `down`
// means, and would double-count a miss inside a probe timeout. The spacing
// arithmetic itself is unit-tested in tests/unit/probeCadence.test.ts.

dbDescribe("probe cadence is not accelerated mid-run", () => {
  const quarterIn = () => ago(Math.max(15, Math.floor(probeSec / 4)));

  it("leaves a warning asset on its configured interval", async () => {
    const midRun = cand({ monitorStatus: "warning", consecutiveFailures: 1, consecutiveSuccesses: 0, lastMonitorAt: quarterIn() });
    const steady = cand({ id: "steady", lastMonitorAt: quarterIn() });

    const due = await computeDueWork([midRun, steady], ALL, now);
    expect(probeDueIds(due)).toEqual([]);
  });

  it("leaves an unconfirmed recovery on its configured interval", async () => {
    const recovering = cand({ monitorStatus: "recovering", consecutiveFailures: 0, consecutiveSuccesses: 1, lastMonitorAt: quarterIn() });

    const due = await computeDueWork([recovering], ALL, now);
    expect(probeDueIds(due)).toEqual([]);
  });

  it("still probes a mid-run asset once its interval has elapsed", async () => {
    const midRun = cand({ monitorStatus: "warning", consecutiveFailures: 1, consecutiveSuccesses: 0, lastMonitorAt: ago(probeSec) });

    const due = await computeDueWork([midRun], ALL, now);
    expect(probeDueIds(due)).toEqual(["cand-1"]);
  });

  it("leaves a down asset on its configured interval too", async () => {
    const down = cand({ monitorStatus: "down", consecutiveFailures: 12, consecutiveSuccesses: 0, lastMonitorAt: quarterIn() });

    const due = await computeDueWork([down], ALL, now);
    expect(probeDueIds(due)).toEqual([]);
  });
});

// ─── ICMP loss sweep (business rules 29 / 30) ────────────────────────────────
// The sampler this replaced ran only while an asset was `warning` or
// `recovering`, and that window WAS the sampling bias that got it disabled: it
// sampled precisely when probes were already failing. The sweep is uniform
// instead, so the tests that matter are the INCLUSIONS — anything that narrows
// the due-set back down to "when things look bad" reintroduces the bias.

dbDescribe("loss-sweep due-set", () => {
  it("includes an asset in EVERY monitor state, not just the unhealthy ones", async () => {
    const assets = ["up", "warning", "recovering", "down", "unknown", "passive"].map((st) =>
      cand({ id: st, monitorStatus: st }),
    );
    const due = await computeDueWork(assets, ALL, now);
    expect(due.lossSamples.map((w) => w.id).sort()).toEqual(
      ["down", "passive", "recovering", "unknown", "up", "warning"],
    );
  });

  it("includes a dependency-suppressed asset", async () => {
    // Excluding these was a cost argument the batched pinger retired; the
    // failures are still marked explained via dependencyDown (rule 38b).
    const due = await computeDueWork([cand({ dependencySuppressed: true })], ALL, now);
    expect(due.lossSamples.map((w) => w.id)).toEqual(["cand-1"]);
  });

  it("excludes maintenance and an asset with nothing to ping", async () => {
    const due = await computeDueWork([
      cand({ id: "maint", status: "maintenance" }),
      cand({ id: "noaddr", ipAddress: null, dnsName: null, hostname: null }),
    ], ALL, now);
    expect(due.lossSamples).toEqual([]);
  });

  it("excludes an asset whose response-time polling is disabled", async () => {
    const due = await computeDueWork([cand({ responseTimePolling: "disabled" })], ALL, now);
    expect(due.lossSamples).toEqual([]);
  });

  it("honours the sweep cadence", async () => {
    const fresh = cand({ id: "fresh", lastLossSampleAt: ago(5) });
    const stale = cand({ id: "stale", lastLossSampleAt: ago(600) });
    const due = await computeDueWork([fresh, stale], ALL, now);
    expect(due.lossSamples.map((w) => w.id)).toEqual(["stale"]);
  });

  it("is independent of the probe cadence — both can be due on one tick", async () => {
    // Separate anchors, and the sweep never touches the counters, so a tick
    // that probes an asset may also burst it.
    const a = cand({ lastMonitorAt: ago(probeSec), lastLossSampleAt: ago(600) });
    const due = await computeDueWork([a], ALL, now);
    expect(probeDueIds(due)).toEqual(["cand-1"]);
    expect(due.lossSamples.map((w) => w.id)).toEqual(["cand-1"]);
  });

  it("caps the per-pass due-set to protect the probe cadence in cursor mode", async () => {
    const many = Array.from({ length: LOSS_SAMPLES_MAX_PER_PASS + 25 }, (_, i) =>
      cand({ id: `a${i}` }),
    );
    const due = await computeDueWork(many, ALL, now);
    expect(due.lossSamples.length).toBe(LOSS_SAMPLES_MAX_PER_PASS);
  });

  it("collects nothing when the cadence is not requested", async () => {
    const due = await computeDueWork([cand()], new Set<MonitorCadence>(["probe"]), now);
    expect(due.lossSamples).toEqual([]);
  });
});

dbDescribe("probe batching", () => {
  it("routes an ICMP asset into the BATCH and everything else per asset", async () => {
    // Only ICMP has a primitive that can ask about many hosts at once. SNMP,
    // WinRM, SSH and REST each need their own authenticated conversation, so
    // they stay one job per asset — snmpMultiGet batches OIDs WITHIN a session
    // and cannot span hosts.
    const due = await computeDueWork([
      cand({ id: "pingable", responseTimePolling: "icmp" }),
      cand({ id: "snmp-one", responseTimePolling: "snmp" }),
      cand({ id: "ssh-one",  responseTimePolling: "ssh" }),
    ], ALL, now);

    expect(due.probeBatch.map((p) => p.id)).toEqual(["pingable"]);
    expect(due.probes.map((p) => p.id).sort()).toEqual(["snmp-one", "ssh-one"]);
  });

  it("carries each asset's own RESOLVED timeout so a bucket cannot borrow another's", async () => {
    const due = await computeDueWork([
      cand({ id: "fast", responseTimePolling: "icmp", probeTimeoutMs: 1000 }),
      cand({ id: "slow", responseTimePolling: "icmp", probeTimeoutMs: 9000 }),
    ], ALL, now);

    const byId = new Map(due.probeBatch.map((p) => [p.id, p]));
    expect(byId.get("fast")?.timeoutMs).toBe(1000);
    expect(byId.get("slow")?.timeoutMs).toBe(9000);
  });

  it("leaves an ICMP asset with no address on the PER-ASSET path", async () => {
    // There is nothing to ping, and an empty target would become an fping
    // argument. Dropping it from the due-set entirely would be worse than the
    // batch: the asset would silently stop being probed. The per-asset path
    // still rejects it with "Asset has no IP address", which is a recorded
    // failure and exactly what happens today.
    const due = await computeDueWork(
      [cand({ id: "noaddr", responseTimePolling: "icmp", ipAddress: null })], ALL, now,
    );
    expect(due.probeBatch).toEqual([]);
    expect(due.probes.map((p) => p.id)).toEqual(["noaddr"]);
  });

  it("still honours the disabled gate", async () => {
    const due = await computeDueWork(
      [cand({ responseTimePolling: "disabled" })], ALL, now,
    );
    expect(probeDueIds(due)).toEqual([]);
  });
});

// ─── SD-WAN cadence (split out of system-info 2026-09) ───────────────────────
// SD-WAN used to ride the system-info pass, so SLA readings arrived only as
// often as interfaces did (10 min by default). It has its own anchor
// (lastSdwanAt) and a per-integration interval (config.sdwanIntervalSeconds,
// default 60s) read from the resolver's integration sidecar — which is why
// these need real Integration rows.

dbDescribe("SD-WAN due-set", () => {
  const PFX = `cdw-sdwan-${Date.now()}`;
  let onId = "";
  let slowId = "";
  let offId = "";

  beforeAll(async () => {
    const mk = (suffix: string, config: Record<string, unknown>) =>
      prisma.integration.create({
        data: { name: `${PFX}-${suffix}`, type: "fortigate", enabled: false, config: config as never },
      });
    onId   = (await mk("on",   { pullSdwan: true })).id;
    slowId = (await mk("slow", { pullSdwan: true, sdwanIntervalSeconds: 600 })).id;
    offId  = (await mk("off",  { pullSdwan: false })).id;
    invalidateMonitorSettingsCache();
  });

  afterAll(async () => {
    await prisma.integration.deleteMany({ where: { name: { startsWith: PFX } } });
    invalidateMonitorSettingsCache();
  });

  const gate = (integrationId: string, over: Partial<MonitorPassCandidate> & { id?: string } = {}) =>
    cand({
      assetType: "firewall",
      discoveredByIntegrationId: integrationId,
      discoveredByIntegration: { type: "fortigate" } as never,
      ...over,
    });

  it("queues a never-polled SD-WAN gate, independent of the system-info cadence", async () => {
    // System-info was polled a moment ago — under the old ride-along the gate
    // would wait its full interface interval for the next SLA reading.
    const due = await computeDueWork([gate(onId, { lastSystemInfoAt: now })], ALL, now);
    expect(due.sdwanWork.map((w) => w.id)).toEqual(["cand-1"]);
    expect(due.systemInfos).toEqual([]);
  });

  it("defaults to a 60s interval", async () => {
    const fresh = await computeDueWork([gate(onId, { lastSdwanAt: ago(30) })], ALL, now);
    expect(fresh.sdwanWork).toEqual([]);
    const stale = await computeDueWork([gate(onId, { lastSdwanAt: ago(60) })], ALL, now);
    expect(stale.sdwanWork).toHaveLength(1);
  });

  it("honours the integration's sdwanIntervalSeconds", async () => {
    const notYet = await computeDueWork([gate(slowId, { lastSdwanAt: ago(300) })], ALL, now);
    expect(notYet.sdwanWork).toEqual([]);
    const due = await computeDueWork([gate(slowId, { lastSdwanAt: ago(600) })], ALL, now);
    expect(due.sdwanWork).toHaveLength(1);
  });

  it("does nothing when the integration's toggle is off, or for an orphan asset", async () => {
    const off = await computeDueWork([gate(offId)], ALL, now);
    expect(off.sdwanWork).toEqual([]);
    const orphan = await computeDueWork([cand({ assetType: "firewall" })], ALL, now);
    expect(orphan.sdwanWork).toEqual([]);
  });

  it("skips a gate that is not confirmed up, and a managed switch", async () => {
    const warning = await computeDueWork([gate(onId, { monitorStatus: "warning" })], ALL, now);
    expect(warning.sdwanWork).toEqual([]);
    const sw = await computeDueWork([gate(onId, { assetType: "switch" })], ALL, now);
    expect(sw.sdwanWork).toEqual([]);
  });

  it("keeps the old REST-only reach: a gate moved to SNMP interfaces is left alone", async () => {
    const snmp = await computeDueWork([gate(onId, { interfacesPolling: "snmp" })], ALL, now);
    expect(snmp.sdwanWork).toEqual([]);
  });

  it("emits nothing when the cadence is not requested (the heavy loop)", async () => {
    const heavy = await computeDueWork(
      [gate(onId)],
      new Set<MonitorCadence>(["telemetry", "systemInfo", "processes", "eventLog"]),
      now,
    );
    expect(heavy.sdwanWork).toEqual([]);
  });
});
