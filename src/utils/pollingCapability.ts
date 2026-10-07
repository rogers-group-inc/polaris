/**
 * src/utils/pollingCapability.ts
 *
 * Does a collector actually EXIST for this (source, stream, method)?
 *
 * Deliberately separate from `pollingCompatibility.ts`, because they answer two
 * different questions and conflating them is how the gap below survived:
 *
 *   compatibility — "is this method MEANINGFUL for this source?"  (can a
 *                   FortiGate speak WinRM? no. can an AD host speak SNMP? no.)
 *   capability    — "has anyone WRITTEN the collector?"
 *
 * Every write validator checked the first and nothing checked the second, so a
 * whole class of settings validated cleanly, persisted, resolved, and then
 * collected nothing — with no error, no failed metric and no log line, because
 * `runTelemetryFor` counts a `{supported:false}` stream as a SUCCESSFUL tick and
 * the queue publishers drop the unimplemented transports before they are even
 * enqueued. An operator could set CPU/memory to SSH on a fleet and watch
 * nothing happen, forever, with every indicator green.
 *
 * ── How this is used, and why it WARNS rather than refuses ──────────────────
 * A hard refusal would 400 an operator who merely re-saves an integration that
 * already holds one of these values — punishing them for a gap they did not
 * create. So the write validators surface warnings, the UI stops OFFERING the
 * dead combinations, and a startup audit names the ones already stored. The one
 * thing that is a hard refuse is ICMP on a non-response-time stream, which was
 * always meant to be refused and simply wasn't checked on the per-asset path.
 *
 * ── Keeping it honest ───────────────────────────────────────────────────────
 * This table is a claim about code that lives elsewhere. When you implement a
 * collector, flip its entry here in the same commit — `tests/unit/
 * pollingCapability.test.ts` pins the shape, but nothing can automatically
 * detect that a collector appeared. The reasons are operator-facing strings, so
 * write them as something a person can act on.
 */

import type { AssetSourceKind, PollingMethod, Stream } from "./pollingCompatibility.js";
import { isFortinetIntegrationType } from "./pollingCompatibility.js";

export interface CapabilityVerdict {
  implemented: boolean;
  /** Operator-facing explanation, present only when `implemented` is false. */
  reason?: string;
}

const OK: CapabilityVerdict = { implemented: true };
const no = (reason: string): CapabilityVerdict => ({ implemented: false, reason });

/** Managed FortiSwitch / FortiAP — proxied behind a controller, not directly REST-able. */
function isManagedChild(assetType: string | null | undefined): boolean {
  return assetType === "switch" || assetType === "access_point";
}

/**
 * The Polaris Agent pushes four sample streams plus two opt-in ones. It does
 * NOT walk LLDP — there is no neighbour discovery in the agent — and there is
 * no temperature story on a host beyond what the telemetry collector already
 * reports, which rides cpuMemory.
 */
const AGENT_STREAMS: ReadonlySet<Stream> = new Set<Stream>([
  "responseTime", "cpuMemory", "temperature", "interfaces", "storage", "processes", "eventLog",
]);

/**
 * Which streams a FortiOS REST call can serve, given the asset's class.
 *
 * A managed FortiSwitch/FortiAP is not directly REST-able: its data comes off
 * the parent gate's controller table, which publishes up/down for both classes
 * and additionally CPU/memory + temperature for an AP (they ride the
 * `wifi/managed_ap` row). Everything else on those classes needs direct SNMP —
 * the collectors hard-guard it, and the queue publishers won't even enqueue it.
 */
function restApiVerdict(source: AssetSourceKind, stream: Stream, assetType: string | null | undefined): CapabilityVerdict {
  if (!isFortinetIntegrationType(source)) {
    // A manual `restapi` credential drives the response-time probe and nothing
    // else — there is no generic telemetry shape for an arbitrary REST device.
    if (stream === "responseTime") return OK;
    return no("REST API only delivers a response-time probe outside a Fortinet integration — there is no generic REST telemetry shape");
  }
  if (stream === "responseTime") return OK;
  if (isManagedChild(assetType)) {
    if (assetType === "access_point" && (stream === "cpuMemory" || stream === "temperature")) return OK;
    if (assetType === "switch" && (stream === "cpuMemory" || stream === "temperature")) {
      return no("A managed FortiSwitch has no REST telemetry — the controller's status table reports up/down only. Use direct SNMP.");
    }
    return no("A managed FortiSwitch / FortiAP is not directly REST-able; only its up/down comes off the parent FortiGate. Use direct SNMP.");
  }
  switch (stream) {
    case "cpuMemory":
    case "temperature":
    case "interfaces":
    case "lldp":
      return OK;
    case "storage":
      return no("FortiOS exposes no mountable storage over REST — the collector always returns an empty list. Use SNMP if the device has an hrStorageTable.");
    case "processes":
      return no("There is no FortiOS endpoint for host processes");
    case "eventLog":
      return no("The FortiOS device-log collector is not implemented — only the Polaris Agent delivers this stream today");
    default:
      return OK;
  }
}

/**
 * Is there a collector for this combination?
 *
 * `assetType` matters only for the Fortinet REST paths (a managed switch and a
 * firewall differ); everything else ignores it.
 */
export function collectorCapability(
  source: AssetSourceKind,
  stream: Stream,
  method: PollingMethod,
  opts?: { assetType?: string | null },
): CapabilityVerdict {
  const assetType = opts?.assetType ?? null;

  // "Do not poll" is always honoured, and the two manager-view methods are
  // implemented for every stream their own matrix scoping allows.
  if (method === "disabled") return OK;
  if (method === "vcenter") return OK;
  if (method === "fortimanager") return OK;
  // Unraid / TrueNAS read the host's own API (WORKLOAD_STREAMS-scoped); a
  // stream a class cannot answer (a container's temperature) comes back empty.
  if (method === "unraid" || method === "truenas") return OK;

  if (method === "icmp") {
    return stream === "responseTime"
      ? OK
      : no("ICMP carries no payload — it can only answer a response-time probe");
  }

  if (method === "agent") {
    return AGENT_STREAMS.has(stream)
      ? OK
      : no("The Polaris Agent does not collect this stream (it performs no LLDP neighbour discovery)");
  }

  if (method === "rest_api") return restApiVerdict(source, stream, assetType);

  if (method === "snmp") {
    if (stream === "processes") {
      return no("SNMP process collection (hrSWRunTable) is declared but not implemented — use the Polaris Agent, SSH or WinRM");
    }
    if (stream === "eventLog") {
      return no("There is no SNMP event-log MIB — use the Polaris Agent");
    }
    return OK;
  }

  // SSH / WinRM, served by agentlessProcessService (processes) and
  // agentlessHostService (cpuMemory / interfaces / storage). What is left
  // unimplemented is genuinely absent, not merely unwired.
  if (method === "ssh" || method === "winrm") {
    const label = method === "ssh" ? "SSH" : "WinRM";
    switch (stream) {
      case "responseTime":
      case "processes":
      case "cpuMemory":
      case "interfaces":
      case "storage":
      case "eventLog":
        // eventLog is journalctl / Get-WinEvent, feeding the same
        // ingestOsEventLog sink the agent's stream uses. Gated by the global
        // agentEventLog master switch. The comment lives here rather than above
        // the label because `no-fallthrough` reads a comment BETWEEN two case
        // labels as the first case's body, and then the whole empty-case group
        // is an error — which is what turned CI red on 2026-08-31.
        return OK;
      case "temperature":
        // Linux hwmon is readable, but there is no dependable Windows
        // equivalent (MSAcpi_ThermalZoneTemperature is unimplemented on most
        // real hardware), so neither side is wired rather than shipping a
        // stream that works on half a fleet.
        return no(`${label} temperature collection is not implemented — host thermal sensors are only available via the Polaris Agent`);
      case "lldp":
        return no(`${label} cannot enumerate LLDP neighbours — use SNMP on a device that publishes LLDP-MIB`);
      default:
        return OK;
    }
  }

  return OK;
}

/** Convenience predicate for call sites that don't need the reason. */
export function collectorExists(
  source: AssetSourceKind,
  stream: Stream,
  method: PollingMethod,
  opts?: { assetType?: string | null },
): boolean {
  return collectorCapability(source, stream, method, opts).implemented;
}

/** Field name (`cpuMemoryPolling`) → stream (`cpuMemory`). */
export function streamFromPollingField(field: string): Stream {
  return field.replace(/Polling$/, "") as Stream;
}
