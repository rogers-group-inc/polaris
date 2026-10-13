/**
 * src/services/rebootService.ts — reboot one asset, now (business rule 112).
 * The orchestration half: what may reboot, how, the run row, the hold, the
 * Events, the proof. The protocol half is services/rebootTransports.ts.
 *
 * What can be rebooted, and through what:
 *
 *   FortiGate     its own REST API or CLI. Refused when it is an HA cluster
 *                 member (`fortinetTopology` haMode / haRole at the click, the
 *                 gate's own `system/ha` when the run starts) — rebooting one
 *                 member fails the cluster over, which this does not
 *                 orchestrate (the rule-87 posture).
 *   FortiSwitch / FortiAP with a controller
 *                 through the controlling FortiGate (`managed-switch/restart`,
 *                 `managed_ap/restart`, or their CLI forms) — a managed AP's
 *                 own UI is usually off. The gate's HA state does not matter:
 *                 only the child reboots.
 *   FortiSwitch / FortiAP with no controller
 *                 its own CLI over SSH (`execute reboot` / `reboot`).
 *   An agent host an `AgentCommand{action:"reboot"}`; the agent refuses unless
 *                 the host carries the reboot marker its opt-in installed.
 *
 * Who may sign the reboot — the OPT-IN, at three places (rule 112):
 *   1. a stored credential with `allowReboot` — the firmware repository's
 *      login binding for the gate, then the gate's own per-stream credentials
 *      (REST API token, device admin login, SSH) — sent to the GATE's address;
 *   2. the discovering FortiGate / FortiManager integration's API token, when
 *      the integration has `allowReboot` — sent where the integration sends it
 *      (its own host, FortiManager's proxy, or FortiManager's direct mode);
 *   3. for an agent host, `ManagedAgent.rebootEnabled` AND the host's own
 *      report that it can (`rebootCapable`).
 * Nothing else reboots anything. The first that applies wins; the run records
 * which one (`RebootRun.authority`) and every Event names it.
 *
 * Every refusal is synchronous and answered to the click; then the run row,
 * the Event, the `device-reboot` hold, and the runner on `setImmediate` —
 * the firmware shape (rule 87), with no queue. A booked reboot is the same
 * call fired by rebootScheduleService.
 *
 * The runner sends the request and then wants PROOF the device went down and
 * came back: its boot time moved (FortiGate `utc_last_reboot`, the agent's
 * `bootTime`), its controller saw it drop and rejoin, or monitoring's own
 * uptime check stamped `Asset.lastRebootAt`. A send that was answered but
 * never followed by any of those is `unverified`, not `succeeded`.
 */

import { createConnection } from "node:net";
import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { UNMONITORABLE_STATUSES } from "../utils/assetInvariants.js";
import { normalizeManufacturer } from "../utils/manufacturerNormalize.js";
import { versionAtLeast } from "../utils/version.js";
import { restApiCredentialAuth } from "../utils/fortinetRestCredential.js";
import {
  buildInfraParentIndex,
  parentAssetWhereOr,
  readControllerStamp,
  readFirewallDeviceName,
  resolveInfraParentAsset,
} from "../utils/fortinetParentKey.js";
import { logEvent } from "./eventLogService.js";
import { openMaintenanceHold, releaseMaintenanceHold } from "./maintenanceScheduleService.js";
import { holdUntilMonitorAnswers } from "./holdRecoveryWait.js";
import { credentialAllowsReboot, getCredential } from "./credentialService.js";
import { resolveFirmwareCredential } from "./firmwareRepositoryService.js";
import { buildTransportForIntegration } from "./reservationPushService.js";
import { publishCommandWake } from "./agentCommandWake.js";
import { _rebootTransportSeams, RebootSendError, type GateLink, type GateOps, type SendResult } from "./rebootTransports.js";
import type { FortiManagerConfig } from "./fortimanagerService.js";

const HOLD_KIND = "device-reboot" as const;
const ACTIVE_STATUSES = ["queued", "sending", "rebooting"] as const;
const LOG_CAP = 300;
const WRITE_THROTTLE_MS = 5_000;
/** The agent build that understands `action: "reboot"`. */
export const MIN_AGENT_REBOOT_VERSION = "0.26.0";
/** An agent not heard from in this long is not offered a reboot. */
const AGENT_STALE_MS = 10 * 60_000;
const INFRA_TYPES = ["firewall", "switch", "access_point"] as const;

export type RebootMethod =
  | "fortigate-rest"
  | "fortigate-ssh"
  | "controller-switch"
  | "controller-ap"
  | "device-ssh"
  | "agent";

export type RebootAvailabilityState =
  | "unsupported"       // nothing Polaris can reboot this asset through
  | "no-address"        // the link needs an address the asset does not have
  | "no-credential"     // no opt-in covers it (no allowReboot credential / integration)
  | "ha"                // a FortiGate HA member
  | "blocked"           // rule-10 status, or a firmware flash is running
  | "running"           // a reboot is in progress
  | "agent-not-active"  // the agent is not installed / enrolled
  | "agent-disabled"    // the host's opt-in is off
  | "agent-incapable"   // opted in, but the host reports it cannot (marker / polkit)
  | "agent-too-old"     // the agent predates the reboot command
  | "agent-offline"     // the agent has not been heard from recently
  | "available";

export interface RebootTimeouts {
  /** How long an agent has to pick up and acknowledge the command before it is withdrawn. */
  agentAckMs: number;
  /** How long to wait for the first sign the device went down (or proof it already cycled). */
  downWaitMs: number;
  /** How long after it went down to wait for it to come back. */
  upWaitMs: number;
  pollMs: number;
  /** The hold-recovery wait (holdRecoveryWait). */
  recoveryWaitMs: number;
  recoveryPollMs: number;
}

export const DEFAULT_REBOOT_TIMEOUTS: RebootTimeouts = {
  agentAckMs: 150_000,
  downWaitMs: 300_000,
  upWaitMs: 900_000,
  pollMs: 10_000,
  recoveryWaitMs: 600_000,
  recoveryPollMs: 15_000,
};

export interface RebootRunSummary {
  id: string;
  assetId: string;
  method: string;
  viaAssetId: string | null;
  credentialId: string | null;
  authority: string;
  status: string;
  stage: string | null;
  error: string | null;
  startedBy: string;
  startedAt: Date;
  finishedAt: Date | null;
  heartbeatAt: Date | null;
}

export interface RebootAvailability {
  state: RebootAvailabilityState;
  available: boolean;
  /** Operator-facing sentence for every non-available state. */
  reason: string | null;
  /** "fortinet" | "agent" — which surface the asset is rebooted as; null when unsupported. */
  kind: "fortinet" | "agent" | null;
  method: RebootMethod | null;
  /** What would sign the reboot, as the operator should read it. */
  authority: string | null;
  /** The gate a managed switch / AP is rebooted through. */
  via: { assetId: string | null; label: string } | null;
  activeRun: RebootRunSummary | null;
  lastRun: RebootRunSummary | null;
}

// ─── Asset + plan resolution ────────────────────────────────────────────────

const CRED_FIELDS = [
  "monitorCredentialId", "responseTimeCredentialId", "cpuMemoryCredentialId", "temperatureCredentialId",
  "interfacesCredentialId", "lldpCredentialId", "customWidgetCredentialId", "processesCredentialId", "eventLogCredentialId",
] as const;

const ASSET_SELECT = {
  id: true, hostname: true, ipAddress: true, dnsName: true, serialNumber: true, manufacturer: true, assetType: true,
  model: true, status: true, monitored: true, fortinetTopology: true, discoveredByIntegrationId: true, lastRebootAt: true,
  monitorCredentialId: true, responseTimeCredentialId: true, cpuMemoryCredentialId: true, temperatureCredentialId: true,
  interfacesCredentialId: true, lldpCredentialId: true, customWidgetCredentialId: true, processesCredentialId: true, eventLogCredentialId: true,
  managedAgent: { select: { id: true, installStatus: true, agentVersion: true, osPlatform: true, rebootEnabled: true, rebootCapable: true, bootTime: true, lastSeenAt: true } },
} as const;

type AssetRow = {
  id: string; hostname: string | null; ipAddress: string | null; dnsName: string | null; serialNumber: string | null;
  manufacturer: string | null; assetType: string; model: string | null; status: string; monitored: boolean;
  fortinetTopology: unknown; discoveredByIntegrationId: string | null; lastRebootAt: Date | null;
  managedAgent: {
    id: string; installStatus: string; agentVersion: string | null; osPlatform: string; rebootEnabled: boolean;
    rebootCapable: boolean | null; bootTime: Date | null; lastSeenAt: Date | null;
  } | null;
} & Record<(typeof CRED_FIELDS)[number], string | null>;

type IntegrationRow = { id: string; name: string; type: string; config: unknown };

function assetLabel(a: { hostname: string | null; ipAddress: string | null }): string | undefined {
  return a.hostname || a.ipAddress || undefined;
}

function isFortinet(manufacturer: string | null | undefined): boolean {
  if (!manufacturer) return false;
  const canon = normalizeManufacturer(manufacturer) ?? manufacturer;
  return /^fortinet\b/i.test(canon.trim());
}

function isFortinetInfra(a: { manufacturer: string | null; assetType: string }): boolean {
  return isFortinet(a.manufacturer) && (INFRA_TYPES as readonly string[]).includes(a.assetType);
}

/** A FortiGate HA member, read from discovery's stamp — the rule-87 test. Null when standalone / unknown. */
export function haMembershipOf(a: { assetType: string; fortinetTopology: unknown }): string | null {
  if (a.assetType !== "firewall") return null;
  const t = (a.fortinetTopology && typeof a.fortinetTopology === "object" ? a.fortinetTopology : {}) as Record<string, unknown>;
  const mode = typeof t.haMode === "string" ? t.haMode : null;
  const role = typeof t.haRole === "string" ? t.haRole : null;
  if (!mode && !role) return null;
  return [mode, role].filter(Boolean).join(", ");
}

function addressOf(a: { ipAddress: string | null; dnsName: string | null }): string | null {
  return a.ipAddress || a.dnsName || null;
}

/** The integration-side opt-in, short of revealing anything: is this token allowed to reboot, and does it exist? */
export function integrationRebootGrant(integration: IntegrationRow | null, deviceName: string | null): { ok: true; label: string } | { ok: false; why: string } {
  if (!integration) return { ok: false, why: "no FortiGate or FortiManager integration discovered it" };
  if (integration.type !== "fortigate" && integration.type !== "fortimanager") return { ok: false, why: `a ${integration.type} integration cannot reboot it` };
  const cfg = (integration.config ?? {}) as Record<string, unknown>;
  if (cfg.allowReboot !== true) return { ok: false, why: `"Allow reboots" is off on the ${integration.name} integration` };
  if (integration.type === "fortigate") {
    if (!String(cfg.apiToken || "").trim() || !String(cfg.host || "").trim()) return { ok: false, why: `the ${integration.name} integration has no host or API token` };
  } else {
    if (!deviceName) return { ok: false, why: "the FortiGate's FortiManager device name is not known yet (run discovery)" };
    if (cfg.useProxy === false && !String(cfg.fortigateApiToken || "").trim()) return { ok: false, why: `the ${integration.name} integration is in direct mode with no FortiGate API token` };
  }
  return { ok: true, label: `Integration API token (${integration.name})` };
}

interface StoredAuthority {
  credentialId: string;
  credentialName: string;
  type: "restapi" | "http" | "ssh";
  source: "firmware-binding" | "asset";
}

/**
 * The stored credentials on (or bound for) a gate that carry `allowReboot`,
 * best first: the firmware repository's login binding, then the asset's own
 * per-stream credentials — a REST API token, a device admin login, SSH.
 */
async function storedAuthoritiesFor(gate: AssetRow): Promise<StoredAuthority[]> {
  const out: StoredAuthority[] = [];
  const binding = await resolveFirmwareCredential(gate, { revealSecrets: false }).catch(() => null);
  const ids = new Set<string>();
  if (binding && binding.source === "credential" && binding.credentialId) ids.add(binding.credentialId);
  for (const f of CRED_FIELDS) if (gate[f]) ids.add(gate[f]!);
  if (ids.size === 0) return out;
  const rows = await prisma.credential.findMany({ where: { id: { in: [...ids] } }, select: { id: true, name: true, type: true, config: true } });
  const allowed = rows.filter((r) => credentialAllowsReboot(r.type, r.config as Record<string, unknown>));
  const rank = (t: string) => (t === "restapi" ? 0 : t === "http" ? 1 : 2);
  const bound = binding?.credentialId ? allowed.find((r) => r.id === binding.credentialId) : undefined;
  if (bound) out.push({ credentialId: bound.id, credentialName: bound.name, type: bound.type as StoredAuthority["type"], source: "firmware-binding" });
  for (const r of allowed.filter((x) => x.id !== bound?.id).sort((x, y) => rank(x.type) - rank(y.type))) {
    out.push({ credentialId: r.id, credentialName: r.name, type: r.type as StoredAuthority["type"], source: "asset" });
  }
  return out;
}

/** The controlling FortiGate of a switch / AP as an asset, resolved the one way (fortinetParentKey). */
async function controllerGateOf(child: AssetRow): Promise<{ gate: AssetRow | null; deviceName: string | null } | null> {
  const stamp = readControllerStamp(child.fortinetTopology);
  if (!stamp.serial && !stamp.name) return null;
  const or = parentAssetWhereOr(stamp);
  const candidates = or.length === 0 ? [] : await prisma.asset.findMany({
    where: { assetType: "firewall", OR: or as never },
    select: ASSET_SELECT,
  }) as unknown as AssetRow[];
  const index = buildInfraParentIndex(candidates.map((c) => ({ id: c.id, hostname: c.hostname, serialNumber: c.serialNumber, assetType: c.assetType, fortinetTopology: c.fortinetTopology })));
  const hit = resolveInfraParentAsset(index, stamp, "firewall");
  const gate = hit ? candidates.find((c) => c.id === hit.id) ?? null : null;
  // An API call addresses the gate by its FortiManager NAME — the stamp's
  // `controllerFortigate` — never by Asset.hostname.
  return { gate, deviceName: stamp.name ?? (gate ? readFirewallDeviceName(gate.fortinetTopology) : null) };
}

async function loadIntegration(id: string | null | undefined): Promise<IntegrationRow | null> {
  if (!id) return null;
  return prisma.integration.findUnique({ where: { id }, select: { id: true, name: true, type: true, config: true } });
}

/** Where a reboot goes and what signs it — resolved without revealing a secret. */
export interface RebootPlan {
  kind: "fortinet" | "agent";
  method: RebootMethod;
  authority: string;
  credentialId: string | null;
  via: { assetId: string | null; label: string } | null;
  /** fortinet: what to reboot through `gate`. */
  target?: { kind: "self" } | { kind: "switch" | "ap"; serial: string; nameHint: string | null };
  /** fortinet: how to build the link at run time. */
  linkFrom?: { kind: "stored"; credentialId: string; type: StoredAuthority["type"]; host: string } | { kind: "integration"; integration: IntegrationRow; deviceName: string | null };
  /** agent */
  managedAgentId?: string;
}

type PlanOrRefusal = { plan: RebootPlan } | { state: RebootAvailabilityState; reason: string };

function typeNoun(t: string): string {
  return t === "firewall" ? "FortiGate" : t === "switch" ? "FortiSwitch" : "FortiAP";
}

async function planFortinet(a: AssetRow): Promise<PlanOrRefusal> {
  const noun = typeNoun(a.assetType);
  const integration = await loadIntegration(a.discoveredByIntegrationId);

  // ── A FortiGate reboots itself ──────────────────────────────────────────
  if (a.assetType === "firewall") {
    const ha = haMembershipOf(a);
    if (ha) return { state: "ha", reason: `The FortiGate is an HA cluster member (${ha}) — rebooting one member fails the cluster over, which Polaris does not orchestrate. Reboot it from the cluster itself.` };
    const host = addressOf(a);
    const stored = host ? await storedAuthoritiesFor(a) : [];
    if (stored.length > 0 && host) {
      const s = stored[0];
      return { plan: {
        kind: "fortinet", method: s.type === "ssh" ? "fortigate-ssh" : "fortigate-rest", authority: s.credentialName, credentialId: s.credentialId, via: null,
        target: { kind: "self" }, linkFrom: { kind: "stored", credentialId: s.credentialId, type: s.type, host },
      } };
    }
    const deviceName = readFirewallDeviceName(a.fortinetTopology) ?? a.hostname;
    const grant = integrationRebootGrant(integration, deviceName);
    if (grant.ok) {
      return { plan: {
        kind: "fortinet", method: "fortigate-rest", authority: grant.label, credentialId: null, via: null,
        target: { kind: "self" }, linkFrom: { kind: "integration", integration: integration!, deviceName },
      } };
    }
    return { state: "no-credential", reason: `Nothing is allowed to reboot this FortiGate: ${host ? "no stored credential on it (or bound for it in the Repository) has Allow reboots on" : "it has no address for a stored credential to reach"}, and ${grant.why}.` };
  }

  // ── A FortiSwitch / FortiAP ─────────────────────────────────────────────
  const serial = (a.serialNumber ?? "").trim();
  const ctl = await controllerGateOf(a);
  if (ctl) {
    if (!serial) return { state: "unsupported", reason: `The ${noun} has no serial number, so its FortiGate cannot be asked to restart it.` };
    const viaLabel = ctl.gate ? (ctl.gate.hostname || ctl.gate.ipAddress || ctl.deviceName || "its FortiGate") : (ctl.deviceName || "its FortiGate");
    const via = { assetId: ctl.gate?.id ?? null, label: viaLabel };
    const method: RebootMethod = a.assetType === "switch" ? "controller-switch" : "controller-ap";
    const target = { kind: (a.assetType === "switch" ? "switch" : "ap") as "switch" | "ap", serial, nameHint: a.hostname };
    const gateHost = ctl.gate ? addressOf(ctl.gate) : null;
    const stored = ctl.gate && gateHost ? await storedAuthoritiesFor(ctl.gate) : [];
    if (stored.length > 0 && gateHost) {
      const s = stored[0];
      return { plan: { kind: "fortinet", method, authority: s.credentialName, credentialId: s.credentialId, via, target, linkFrom: { kind: "stored", credentialId: s.credentialId, type: s.type, host: gateHost } } };
    }
    // The child's own discovering integration is the gate's (one FortiManager
    // or one standalone gate discovers both); the gate asset's, when known, wins.
    const gateIntegration = ctl.gate?.discoveredByIntegrationId ? await loadIntegration(ctl.gate.discoveredByIntegrationId) : integration;
    const grant = integrationRebootGrant(gateIntegration, ctl.deviceName);
    if (grant.ok) {
      return { plan: { kind: "fortinet", method, authority: grant.label, credentialId: null, via, target, linkFrom: { kind: "integration", integration: gateIntegration!, deviceName: ctl.deviceName } } };
    }
    return { state: "no-credential", reason: `The ${noun} is restarted through ${viaLabel}, and nothing is allowed to reboot through it: ${ctl.gate ? "no stored credential on that FortiGate has Allow reboots on" : "Polaris has no asset for that FortiGate to hold a credential"}, and ${grant.why}.` };
  }

  // ── No controller: the device's own CLI ─────────────────────────────────
  const host = addressOf(a);
  if (!host) return { state: "no-address", reason: `The ${noun} has no controller FortiGate and no address to reach its own CLI at.` };
  const ssh = (await storedAuthoritiesFor(a)).find((s) => s.type === "ssh");
  if (!ssh) return { state: "no-credential", reason: `The ${noun} has no controller FortiGate, so it is rebooted over its own SSH CLI — and no SSH credential on it has Allow reboots on.` };
  return { plan: { kind: "fortinet", method: "device-ssh", authority: ssh.credentialName, credentialId: ssh.credentialId, via: null, target: { kind: "self" }, linkFrom: { kind: "stored", credentialId: ssh.credentialId, type: "ssh", host } } };
}

function planAgent(a: AssetRow, now = Date.now()): PlanOrRefusal {
  const m = a.managedAgent!;
  if (m.installStatus !== "active") return { state: "agent-not-active", reason: `The Polaris Agent on this host is ${m.installStatus.replace(/_/g, " ")}, not active.` };
  if (!m.rebootEnabled) return { state: "agent-disabled", reason: "Reboots are not enabled for this host. Enable them on the Polaris Agent card (it installs the host-side permission over the agent's install credential)." };
  if (!versionAtLeast(m.agentVersion, MIN_AGENT_REBOOT_VERSION)) return { state: "agent-too-old", reason: `The Polaris Agent here is ${m.agentVersion ?? "an unknown version"}; rebooting needs ${MIN_AGENT_REBOOT_VERSION} or newer — upgrade the agent.` };
  if (m.rebootCapable !== true) {
    return { state: "agent-incapable", reason: m.rebootCapable === false
      ? "Reboots are enabled, but the host reports it cannot reboot itself for the agent (the reboot marker or, on Linux, the polkit rule is missing or not honoured). Turn reboots off and on again on the Polaris Agent card to reinstall them."
      : "Reboots are enabled, but the agent has not yet reported whether the host allows it — wait for its next heartbeat." };
  }
  if (!m.lastSeenAt || now - m.lastSeenAt.getTime() > AGENT_STALE_MS) return { state: "agent-offline", reason: "The Polaris Agent has not been heard from in the last 10 minutes — a reboot command would wait for it and fire whenever it returns." };
  return { plan: { kind: "agent", method: "agent", authority: "Polaris Agent", credentialId: null, via: null, managedAgentId: m.id } };
}

async function planFor(a: AssetRow): Promise<PlanOrRefusal> {
  if (isFortinetInfra(a)) return planFortinet(a);
  if (a.managedAgent) return planAgent(a);
  return { state: "unsupported", reason: "Polaris can reboot FortiGates, FortiSwitches, FortiAPs and hosts running the Polaris Agent." };
}

/** Gates that read the asset's state, not its route. Empty = clear. */
async function stateBlockers(a: AssetRow): Promise<string[]> {
  const out: string[] = [];
  if ((UNMONITORABLE_STATUSES as readonly string[]).includes(a.status)) out.push(`the asset is ${a.status}`);
  const flash = await prisma.firmwareUpgradeRun.findFirst({ where: { assetId: a.id, status: { in: ["queued", "running"] } }, select: { id: true } });
  if (flash) out.push("a firmware upgrade is running on it — a reboot mid-flash can leave it unbootable");
  return out;
}

function summarize(r: {
  id: string; assetId: string; method: string; viaAssetId: string | null; credentialId: string | null; authority: string;
  status: string; stage: string | null; error: string | null; startedBy: string; startedAt: Date; finishedAt: Date | null; heartbeatAt: Date | null;
}): RebootRunSummary {
  return {
    id: r.id, assetId: r.assetId, method: r.method, viaAssetId: r.viaAssetId, credentialId: r.credentialId, authority: r.authority,
    status: r.status, stage: r.stage, error: r.error, startedBy: r.startedBy, startedAt: r.startedAt, finishedAt: r.finishedAt, heartbeatAt: r.heartbeatAt,
  };
}

async function activeRunFor(assetId: string) {
  return prisma.rebootRun.findFirst({ where: { assetId, status: { in: [...ACTIVE_STATUSES] } }, orderBy: { startedAt: "desc" } });
}

async function lastRunFor(assetId: string) {
  return prisma.rebootRun.findFirst({ where: { assetId, status: { notIn: [...ACTIVE_STATUSES] } }, orderBy: { startedAt: "desc" } });
}

async function loadAsset(assetId: string): Promise<AssetRow> {
  const a = await prisma.asset.findUnique({ where: { id: assetId }, select: ASSET_SELECT }) as unknown as AssetRow | null;
  if (!a) throw new AppError(404, "Asset not found");
  return a;
}

/**
 * Everything the Status row's Reboot button needs in one read. A handful of
 * point queries; the controller lookup only for a switch / AP.
 */
export async function getRebootAvailability(assetId: string): Promise<RebootAvailability> {
  const a = await loadAsset(assetId);
  const [active, last] = await Promise.all([activeRunFor(a.id), lastRunFor(a.id)]);
  const base: RebootAvailability = {
    state: "available", available: false, reason: null, kind: null, method: null, authority: null, via: null,
    activeRun: active ? summarize(active) : null, lastRun: last ? summarize(last) : null,
  };
  const kind: RebootAvailability["kind"] = isFortinetInfra(a) ? "fortinet" : a.managedAgent ? "agent" : null;
  if (!kind) return { ...base, state: "unsupported", reason: "Polaris can reboot FortiGates, FortiSwitches, FortiAPs and hosts running the Polaris Agent." };
  if (active) return { ...base, kind, state: "running", reason: "A reboot is in progress on this device." };
  const res = await planFor(a);
  if ("state" in res) return { ...base, kind, state: res.state, reason: res.reason };
  const blockers = await stateBlockers(a);
  const p = res.plan;
  const shaped = { ...base, kind, method: p.method, authority: p.authority, via: p.via };
  if (blockers.length > 0) return { ...shaped, state: "blocked", reason: `Cannot reboot: ${blockers.join("; ")}.` };
  return { ...shaped, state: "available", available: true };
}

/**
 * What a BOOKING checks when it is made (the rule-93 shape): that something
 * may reboot the asset at all. Its live state is taken when it fires.
 */
export async function checkSchedulableReboot(assetId: string): Promise<{ plan: RebootPlan; warnings: string[] }> {
  const a = await loadAsset(assetId);
  if (!isFortinetInfra(a) && !a.managedAgent) throw new AppError(400, "Polaris can reboot FortiGates, FortiSwitches, FortiAPs and hosts running the Polaris Agent");
  const res = await planFor(a);
  // An agent that is merely offline now may be back at the booked time.
  if ("state" in res && res.state !== "agent-offline") throw new AppError(res.state === "ha" || res.state === "unsupported" ? 400 : 409, res.reason);
  const warnings = "state" in res ? [res.reason] : [];
  const plan = "plan" in res ? res.plan : { kind: "agent" as const, method: "agent" as const, authority: "Polaris Agent", credentialId: null, via: null };
  return { plan, warnings: [...warnings, ...(await stateBlockers(a))] };
}

// ─── Start ───────────────────────────────────────────────────────────────────

/** A 409 that clears on its own — a reboot already running on the device. A booking that meets it waits. */
export class RebootRunConflictError extends AppError {
  constructor(message: string) {
    super(409, message);
    this.name = "RebootRunConflictError";
  }
}

export interface StartRebootInput {
  assetId: string;
  actor: string;
  /** The booking this start fires; linked to the run, and emailed when it ends. */
  scheduleId?: string;
  /** Tests: short clocks. */
  overrides?: { timeouts?: Partial<RebootTimeouts> };
}

function methodPhrase(p: RebootPlan): string {
  switch (p.method) {
    case "controller-switch": return `through FortiGate ${p.via?.label ?? "?"} (managed FortiSwitch restart)`;
    case "controller-ap":     return `through FortiGate ${p.via?.label ?? "?"} (managed FortiAP restart)`;
    case "fortigate-rest":    return "over the FortiGate's REST API";
    case "fortigate-ssh":     return "over the FortiGate's SSH CLI";
    case "device-ssh":        return "over the device's own SSH CLI";
    case "agent":             return "through the Polaris Agent";
  }
}

export async function startReboot(input: StartRebootInput): Promise<RebootRunSummary> {
  const a = await loadAsset(input.assetId);
  if (!isFortinetInfra(a) && !a.managedAgent) throw new AppError(400, "Polaris can reboot FortiGates, FortiSwitches, FortiAPs and hosts running the Polaris Agent");
  const res = await planFor(a);
  if ("state" in res) throw new AppError(res.state === "ha" || res.state === "unsupported" ? 400 : 409, `Cannot reboot: ${res.reason}`);
  const plan = res.plan;
  const blockers = await stateBlockers(a);
  if (blockers.length > 0) throw new AppError(409, `Cannot reboot: ${blockers.join("; ")}`);
  if (await activeRunFor(a.id)) throw new RebootRunConflictError("A reboot is already in progress on this device");

  let run;
  try {
    run = await prisma.rebootRun.create({
      data: {
        assetId: a.id, method: plan.method, viaAssetId: plan.via?.assetId ?? null, credentialId: plan.credentialId,
        authority: plan.authority, status: "queued", startedBy: input.actor, heartbeatAt: new Date(),
        bootTimeBefore: plan.kind === "agent" ? a.managedAgent?.bootTime ?? null : null,
      },
    });
  } catch (err: any) {
    if (err?.code === "P2002") throw new RebootRunConflictError("A reboot is already in progress on this device");
    throw err;
  }
  if (input.scheduleId) {
    await prisma.rebootSchedule.update({ where: { id: input.scheduleId }, data: { runId: run.id } })
      .catch((err) => logger.warn({ err, runId: run.id, scheduleId: input.scheduleId }, "reboot: could not link the run to its booking"));
  }

  await logEvent({
    action: "asset.reboot_started",
    resourceType: "asset",
    resourceId: a.id,
    resourceName: assetLabel(a),
    actor: input.actor,
    level: "info",
    message: `${input.scheduleId ? "Scheduled reboot" : "Reboot"} started ${methodPhrase(plan)}, signed by "${plan.authority}"`,
    details: { runId: run.id, method: plan.method, authority: plan.authority, credentialId: plan.credentialId, viaAssetId: plan.via?.assetId ?? null, via: plan.via?.label ?? null, scheduleId: input.scheduleId ?? null },
  });

  // Best-effort, like the firmware hold: a hold failure must never be the
  // reason a reboot does not run. It suppresses everything behind the device
  // (rule 38) — which is exactly what a reboot is about to take down.
  try {
    await openMaintenanceHold({ assetId: a.id, kind: HOLD_KIND, actor: input.actor });
  } catch (err) {
    logger.warn({ err, assetId: a.id }, "Could not hold the asset in maintenance for the reboot");
  }

  const timeouts = { ...DEFAULT_REBOOT_TIMEOUTS, ...(input.overrides?.timeouts ?? {}) };
  setImmediate(() => {
    runReboot(run.id, a, plan, timeouts)
      .catch((err) => logger.error({ err, runId: run.id }, "Reboot runner crashed unexpectedly"))
      .finally(() => { if (input.scheduleId) void notifyScheduledRun(run.id); });
  });
  return summarize(run);
}

/** Lazy, like the firmware runner: the schedule service imports this one. */
async function notifyScheduledRun(runId: string): Promise<void> {
  try {
    const { notifyScheduledRebootFinished } = await import("./rebootScheduleService.js");
    await notifyScheduledRebootFinished(runId);
  } catch (err) {
    logger.warn({ err, runId }, "reboot: the scheduled-run results email could not be sent");
  }
}

// ─── Run ─────────────────────────────────────────────────────────────────────

/** Build the live link for a Fortinet plan — the only place a secret is revealed. */
async function linkFor(plan: RebootPlan): Promise<GateLink> {
  const from = plan.linkFrom!;
  if (from.kind === "stored") {
    const cred = await getCredential(from.credentialId, { revealSecrets: true });
    const cfg = (cred.config ?? {}) as Record<string, unknown>;
    if (!credentialAllowsReboot(cred.type, cfg)) throw new RebootSendError(`the credential "${cred.name}" no longer allows reboots`);
    if (cred.type === "ssh") return { kind: "ssh", host: from.host, config: cfg };
    if (cred.type === "restapi") {
      const auth = restApiCredentialAuth(cfg);
      if ("error" in auth) throw new RebootSendError(auth.error);
      return { kind: "token", host: from.host, port: auth.port ?? 443, token: auth.apiToken, verifyTls: auth.verifySsl, vdom: "root" };
    }
    if (typeof cfg.username !== "string" || typeof cfg.password !== "string" || !cfg.password) throw new RebootSendError(`the credential "${cred.name}" has no usable login`);
    return { kind: "login", host: from.host, port: 443, username: cfg.username, password: cfg.password, verifyTls: false, vdom: "root" };
  }
  const integ = from.integration;
  const fresh = await loadIntegration(integ.id);
  const grant = integrationRebootGrant(fresh, from.deviceName);
  if (!grant.ok) throw new RebootSendError(grant.why);
  const t = await buildTransportForIntegration(fresh!, from.deviceName ?? "");
  if (t.kind === "fmg-proxy") return { kind: "fmg-proxy", fmgConfig: t.fmgConfig as FortiManagerConfig, deviceName: t.deviceName, integrationId: t.integrationId, vdom: t.vdom };
  return { kind: "token", host: t.fgConfig.host, port: t.fgConfig.port || 443, token: t.fgConfig.apiToken, verifyTls: t.fgConfig.verifySsl === true, vdom: t.vdom };
}

/** What one poll of the device says. `unknown`: could not tell (a transient read error) — counts as neither up nor down. */
interface ProbeReading { up: boolean; proven: boolean; unknown?: boolean; note?: string }

type WatchOutcome = { result: "proven"; note?: string } | { result: "not-back" } | { result: "never-down" };

/**
 * Watch for the reboot. Every reading also asks monitoring's own uptime
 * check (`Asset.lastRebootAt` moving past the start) — proof from a source
 * the link may not have.
 */
async function watchReboot(
  assetId: string,
  startedAt: Date,
  probe: () => Promise<ProbeReading>,
  t: RebootTimeouts,
  log: (level: "info" | "warn" | "error", msg: string) => void,
  setStage: (s: string) => void,
  flush: () => Promise<void>,
): Promise<WatchOutcome> {
  const t0 = Date.now();
  let wentDown = false;
  let downAt = 0;
  for (;;) {
    await new Promise((r) => setTimeout(r, t.pollMs));
    const monitor = await prisma.asset.findUnique({ where: { id: assetId }, select: { lastRebootAt: true } }).catch(() => null);
    if (monitor?.lastRebootAt && monitor.lastRebootAt > startedAt) return { result: "proven", note: "monitoring saw the device's uptime reset" };
    let r: ProbeReading;
    try {
      r = await probe();
    } catch (err) {
      r = { up: false, proven: false, note: err instanceof Error ? err.message : String(err) };
    }
    if (r.proven && r.up) return { result: "proven", note: r.note };
    if (!r.up && !r.unknown && !wentDown) {
      wentDown = true;
      downAt = Date.now();
      setStage("down");
      log("info", `the device stopped answering${r.note ? ` (${r.note})` : ""}`);
      await flush();
    }
    if (wentDown && Date.now() - downAt > t.upWaitMs) return { result: "not-back" };
    if (!wentDown && Date.now() - t0 > t.downWaitMs) return { result: "never-down" };
    await flush();
  }
}

/** TCP connect, short — "is anything listening". */
function tcpUp(host: string, port: number, timeoutMs = 3_000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection({ host, port });
    const done = (ok: boolean) => { s.destroy(); resolve(ok); };
    s.setTimeout(timeoutMs, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

async function runReboot(runId: string, a: AssetRow, plan: RebootPlan, t: RebootTimeouts): Promise<void> {
  const startedAt = new Date();
  const log: Array<{ t: string; level: string; msg: string }> = [];
  let status: "sending" | "rebooting" = "sending";
  let stage: string | null = "sending";
  let dirty = true;
  let lastWrite = 0;
  let bootTimeBefore: Date | null = plan.kind === "agent" ? a.managedAgent?.bootTime ?? null : null;
  const push = (level: "info" | "warn" | "error", msg: string) => {
    log.push({ t: new Date().toISOString(), level, msg });
    if (log.length > LOG_CAP) log.splice(0, log.length - LOG_CAP);
    dirty = true;
  };
  const flush = async (force = false) => {
    if (!dirty && !force) return;
    if (!force && Date.now() - lastWrite < WRITE_THROTTLE_MS) return;
    dirty = false;
    lastWrite = Date.now();
    await prisma.rebootRun.update({
      where: { id: runId },
      data: { status, stage, log: log as object[], heartbeatAt: new Date(), bootTimeBefore },
    }).catch((err) => logger.warn({ err, runId }, "reboot run progress write failed"));
  };
  const finish = async (final: "succeeded" | "failed" | "unverified", error: string | null) => {
    await prisma.rebootRun.update({
      where: { id: runId },
      data: { status: final, stage, log: log as object[], error, finishedAt: new Date(), heartbeatAt: new Date(), bootTimeBefore },
    }).catch((err) => logger.error({ err, runId }, "reboot run terminal write failed"));
  };
  const label = assetLabel(a);
  const fail = async (msg: string) => {
    push("error", msg);
    await dropHold(a.id);
    await finish("failed", msg);
    await logEvent({
      action: "asset.reboot_failed", resourceType: "asset", resourceId: a.id, resourceName: label, actor: "system:reboot", level: "warning",
      message: `Reboot failed${stage ? ` at ${stage}` : ""}: ${msg}`,
      details: { runId, method: plan.method, authority: plan.authority, stage, error: msg },
    });
  };

  let ops: GateOps | null = null;
  try {
    push("info", `reboot of ${label ?? a.id} ${methodPhrase(plan)}, signed by "${plan.authority}"`);
    await flush(true);

    let probe: () => Promise<ProbeReading>;
    let sent: SendResult = {};

    if (plan.kind === "agent") {
      // ── agent: enqueue, wake, wait for the acknowledgement ──────────────
      const cmd = await prisma.agentCommand.create({
        data: { assetId: a.id, managedAgentId: plan.managedAgentId!, action: "reboot", target: "host", payload: { runId, requestedBy: "polaris" }, requestedBy: "system:reboot" },
      });
      await publishCommandWake(plan.managedAgentId!).catch(() => undefined);
      push("info", "reboot command queued for the agent");
      await flush(true);
      const ackBy = Date.now() + t.agentAckMs;
      let acked: { status: string; error: string | null } | null = null;
      while (Date.now() < ackBy) {
        await new Promise((r) => setTimeout(r, Math.min(t.pollMs, 5_000)));
        const row = await prisma.agentCommand.findUnique({ where: { id: cmd.id }, select: { status: true, error: true } });
        if (row && (row.status === "succeeded" || row.status === "failed")) { acked = row; break; }
      }
      if (!acked) {
        // Withdraw it: an agent that comes back later must not reboot the host
        // hours after anyone asked. A command it already took is past saving.
        const withdrawn = await prisma.agentCommand.updateMany({ where: { id: cmd.id, status: "pending" }, data: { status: "failed", error: "withdrawn: not picked up in time", completedAt: new Date() } });
        if (withdrawn.count > 0) return await fail(`the agent did not pick up the reboot command within ${Math.round(t.agentAckMs / 1000)} s; it was withdrawn and will not run`);
        return await fail(`the agent took the reboot command but did not acknowledge it within ${Math.round(t.agentAckMs / 1000)} s — check the host`);
      }
      if (acked.status === "failed") return await fail(`the agent refused: ${acked.error ?? "no reason given"}`);
      push("info", "the agent acknowledged and is rebooting the host");
      probe = async () => {
        const m = await prisma.managedAgent.findUnique({ where: { id: plan.managedAgentId! }, select: { bootTime: true, wsConnectedAt: true, wsDisconnectedAt: true } });
        const proven = !!(m?.bootTime && (!bootTimeBefore || m.bootTime.getTime() > bootTimeBefore.getTime() + 60_000) && m.bootTime.getTime() > startedAt.getTime() - 120_000);
        const disconnected = !!(m?.wsDisconnectedAt && m.wsDisconnectedAt > startedAt && (!m.wsConnectedAt || m.wsConnectedAt < m.wsDisconnectedAt));
        return { up: proven || !disconnected, proven, unknown: !disconnected && !proven, note: proven ? `the agent reports the host booted at ${m!.bootTime!.toISOString()}` : undefined };
      };
    } else {
      // ── Fortinet: build the link, preflight, send ───────────────────────
      const link = await linkFor(plan);
      ops = _rebootTransportSeams.gateOps(link);
      push("info", `connecting: ${ops.label}`);
      await flush(true);
      const target = plan.target!;
      if (target.kind === "self") {
        if (a.assetType === "firewall") {
          const serial = await ops.serial().catch((err) => { throw new RebootSendError(`could not read the FortiGate's status (${err instanceof Error ? err.message : String(err)})`); });
          if (serial && a.serialNumber && serial.toUpperCase() !== a.serialNumber.toUpperCase()) {
            throw new RebootSendError(`the device that answered reports serial ${serial}, not ${a.serialNumber} — refusing to reboot a device that is not this asset`);
          }
          const mode = await ops.haMode().catch(() => null);
          if (mode === null) throw new RebootSendError("could not read the FortiGate's HA mode — refusing, since rebooting an HA member fails the cluster over");
          if (mode !== "standalone") throw new RebootSendError(`the FortiGate is in an HA cluster (mode ${mode}) — rebooting HA members is not supported`);
        }
        if (plan.method !== "device-ssh") bootTimeBefore = await ops.bootTime().catch(() => null);
        if (bootTimeBefore) push("info", `last booted ${bootTimeBefore.toISOString()}`);
        push("info", "sending the reboot");
        await flush(true);
        sent = await ops.rebootSelf(`Reboot requested from Polaris (run ${runId})`);
        const host = link.kind === "fmg-proxy" ? null : link.host;
        if (link.kind === "ssh") {
          let down = false;
          probe = async () => {
            const up = await tcpUp(link.host, Number(link.config.port) || 22);
            if (!up) down = true;
            return { up, proven: down && up, note: up ? (down ? "its SSH port closed and reopened" : undefined) : "SSH port closed" };
          };
        } else {
          probe = async () => {
            try {
              const bt = await ops!.bootTime();
              const proven = !!bt && (bootTimeBefore ? bt.getTime() > bootTimeBefore.getTime() + 1_000 : bt.getTime() > startedAt.getTime() - 60_000);
              // Compared against the box's OWN previous boot time, never against
              // Polaris's clock: a gate's clock may be minutes off (seen on the lab).
              return { up: true, proven, note: proven ? `the FortiGate's boot time moved${bootTimeBefore ? ` from ${bootTimeBefore.toISOString()}` : ""} to ${bt!.toISOString()} (its own clock)` : undefined };
            } catch (err) {
              // A gate that is rebooting does not answer; one whose proxy or
              // token failed for another reason would look the same — the
              // TCP port says which.
              const reachable = host ? await tcpUp(host, link.kind === "token" || link.kind === "login" ? link.port : 443) : false;
              return { up: false, proven: false, unknown: reachable, note: err instanceof Error ? err.message : String(err) };
            }
          };
        }
      } else {
        // Managed switch / AP through its gate.
        const isSwitch = target.kind === "switch";
        let name: string;
        let joinBefore: number | null = null;
        const list = isSwitch ? await ops.managedSwitches().catch((err) => { throw new RebootSendError(`could not list the FortiGate's managed FortiSwitches (${err instanceof Error ? err.message : String(err)})`); })
                              : await ops.managedAps().catch((err) => { throw new RebootSendError(`could not list the FortiGate's managed FortiAPs (${err instanceof Error ? err.message : String(err)})`); });
        if (list === null) {
          // The CLI link cannot list; the AP command takes the serial, the
          // switch command its switch-id (the hostname discovery recorded).
          name = isSwitch ? (target.nameHint && /^[A-Za-z0-9._:-]{1,64}$/.test(target.nameHint) ? target.nameHint : target.serial) : target.serial;
          push("info", `restarting ${isSwitch ? "FortiSwitch" : "FortiAP"} ${name} through the FortiGate CLI`);
        } else {
          const hit = (list as Array<{ serial: string; status: string | null; switchId?: string; wtpId?: string; joinTime: number | null }>)
            .find((x) => x.serial.toUpperCase() === target.serial.toUpperCase());
          if (!hit) throw new RebootSendError(`FortiGate ${plan.via?.label ?? "?"} does not list ${isSwitch ? "a FortiSwitch" : "a FortiAP"} with serial ${target.serial} — it is not managed there now`);
          name = (isSwitch ? hit.switchId : hit.wtpId) || target.serial;
          joinBefore = hit.joinTime ?? null;
          push("info", `the FortiGate manages it as "${name}" (status ${hit.status ?? "unknown"})`);
        }
        await flush(true);
        sent = isSwitch ? await ops.restartSwitch(name) : await ops.restartAp(name);
        if (list === null) {
          probe = async () => ({ up: false, proven: false, unknown: true });
        } else {
          let sawDown = false;
          probe = async () => {
            const now = isSwitch ? await ops!.managedSwitches() : await ops!.managedAps();
            const hit = (now ?? []).find((x) => x.serial.toUpperCase() === target.serial.toUpperCase()) as { status: string | null; joinTime?: number | null } | undefined;
            const up = !!hit && String(hit.status ?? "").toLowerCase() === (isSwitch ? "connected" : "connected");
            if (!up) sawDown = true;
            const rejoined = joinBefore !== null && hit?.joinTime != null && hit.joinTime > joinBefore;
            const link = isSwitch ? "FortiLink" : "CAPWAP";
            return { up, proven: up && (sawDown || rejoined), note: up ? (rejoined ? `the FortiGate shows it rejoined ${link}` : "the FortiGate shows it connected again") : `the FortiGate shows it ${hit ? String(hit.status ?? "not connected") : "missing"}` };
          };
        }
      }
      push("info", sent.uncertain ? `the request went out but its answer was lost (${sent.uncertain}) — watching for the reboot` : "the device accepted the reboot");
    }

    status = "rebooting";
    stage = "rebooting";
    await flush(true);

    const outcome = await watchReboot(a.id, startedAt, probe, t, push, (s) => { stage = s; }, () => flush());
    if (outcome.result === "not-back") {
      return await fail(`the device went down and did not come back within ${Math.round(t.upWaitMs / 60_000)} min`);
    }
    if (outcome.result === "proven") {
      stage = "recovering";
      push("info", outcome.note ? `rebooted: ${outcome.note}` : "rebooted");
      await holdUntilMonitorAnswers(a.id, HOLD_KIND, t, { onWaiting: () => { stage = "recovering"; }, push, flush });
      await dropHold(a.id);
      await finish("succeeded", null);
      const secs = Math.round((Date.now() - startedAt.getTime()) / 1000);
      await logEvent({
        action: "asset.reboot_succeeded", resourceType: "asset", resourceId: a.id, resourceName: label, actor: "system:reboot", level: "info",
        message: `Reboot finished: ${outcome.note ?? "the device came back"} (${secs} s)`,
        details: { runId, method: plan.method, authority: plan.authority, durationMs: Date.now() - startedAt.getTime() },
      });
      return;
    }
    // Sent, but never seen to go down and no boot-time proof.
    const why = sent.uncertain
      ? "the request's answer was lost and the device was never seen to go down"
      : "the device accepted the reboot but was never seen to go down and its boot time did not change";
    push("warn", why);
    await dropHold(a.id);
    await finish("unverified", why);
    await logEvent({
      action: "asset.reboot_unverified", resourceType: "asset", resourceId: a.id, resourceName: label, actor: "system:reboot", level: "warning",
      message: `Reboot unverified: ${why} — check the device`,
      details: { runId, method: plan.method, authority: plan.authority },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await fail(err instanceof RebootSendError ? msg : `runner error: ${msg}`);
  } finally {
    await ops?.close().catch(() => undefined);
  }
}

async function dropHold(assetId: string): Promise<void> {
  try {
    await releaseMaintenanceHold({ assetId, kind: HOLD_KIND });
  } catch (err) {
    logger.warn({ err, assetId }, "Could not release the reboot maintenance hold (it will expire on its own)");
  }
}

// ─── Reads ───────────────────────────────────────────────────────────────────

export async function getRebootRunForAsset(assetId: string, runId: string): Promise<RebootRunSummary & { log: Array<{ t: string; level: string; msg: string }> }> {
  const r = await prisma.rebootRun.findUnique({ where: { id: runId } });
  if (!r || r.assetId !== assetId) throw new AppError(404, "Reboot run not found");
  return { ...summarize(r), log: (r.log as Array<{ t: string; level: string; msg: string }>) ?? [] };
}

export async function listRebootRunsForAsset(assetId: string, limit = 20): Promise<RebootRunSummary[]> {
  const rows = await prisma.rebootRun.findMany({ where: { assetId }, orderBy: { startedAt: "desc" }, take: Math.min(Math.max(limit, 1), 100) });
  return rows.map(summarize);
}

/**
 * At web-process boot: a reboot this process was driving when it died can
 * never finish. Mark it failed and release its hold. The device may well have
 * rebooted — the message says to check.
 */
export async function failOrphanedRebootRuns(): Promise<number> {
  const orphans = await prisma.rebootRun.findMany({ where: { status: { in: [...ACTIVE_STATUSES] } }, select: { id: true, assetId: true, asset: { select: { hostname: true, ipAddress: true } } } });
  for (const o of orphans) {
    const msg = "Polaris restarted while the reboot was being watched; the device may or may not have rebooted — check it";
    await prisma.rebootRun.update({ where: { id: o.id }, data: { status: "failed", error: msg, finishedAt: new Date() } }).catch(() => undefined);
    await dropHold(o.assetId);
    await logEvent({
      action: "asset.reboot_failed", resourceType: "asset", resourceId: o.assetId, resourceName: assetLabel(o.asset), actor: "system:reboot", level: "warning",
      message: `Reboot orphaned: ${msg}`, details: { runId: o.id, orphaned: true },
    });
    await notifyScheduledRun(o.id);
  }
  return orphans.length;
}
