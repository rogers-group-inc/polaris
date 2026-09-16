/**
 * src/utils/pollingCompatibility.ts
 *
 * Pure compatibility matrix between asset sources and polling methods.
 * Used by the resolver (silently falls through when a higher-tier value
 * isn't valid for an asset's source), the routes (Zod validation when an
 * operator picks a method on a class override), and the UI (disable the
 * options that don't apply for a given source).
 *
 * Asset source = which integration discovered the asset (or "manual" for
 * orphans). The new polling-method redesign treats Manual as its own
 * asset source, with the most permissive matrix (any method) since the
 * operator chooses the credential when adding the asset.
 *
 *   FortiManager      → REST API, SNMP, SSH, ICMP, FortiManager   (no WinRM — FortiOS doesn't run it; no Agent — appliance)
 *   FortiGate         → REST API, SNMP, SSH, ICMP                (same — FortiOS again)
 *   Active Directory  → ICMP, WinRM, SSH, Agent                  (no REST API — AD-bound hosts have no shared API)
 *   Entra ID / Intune → ICMP, WinRM, SSH, Agent                  (same — cloud-managed Windows / mobile)
 *   Windows Server    → ICMP, WinRM, SSH, Agent                  (DHCP discovery surfaces Windows hosts)
 *   Azure Arc         → ICMP, WinRM, SSH, Agent                  (Arc-enabled servers are ordinary Windows/Linux
 *                                                                 hosts — the Connected Machine agent is a cloud
 *                                                                 control-plane link, not a Polaris transport)
 *   vCenter           → ICMP, SNMP, WinRM, SSH, Agent,           (VMs are guest OSes → the directory-set methods
 *                       vCenter                                   apply; ESXi hosts also answer SNMP/SSH; "vcenter"
 *                                                                 is the DEFAULT for both roles — see below)
 *   Manual            → any                                       (operator-chosen)
 *
 * ── The retired "http" method (2026-08) ──────────────────────────────────────
 * There WAS an `http` polling method here: a responseTime-only GET that decided
 * up/down from a status code and a body match. It is gone, and the HTTP check
 * it performed now lives as a MANUFACTURER CUSTOM WIDGET instead
 * (`ManufacturerCustomWidget.widgetType = "http"`).
 *
 * The move is about where a check DEFINITION belongs. As a polling method the
 * definition had to ride an `http`-typed Credential, which made a credential —
 * the thing that answers "how do I authenticate to this vendor" — also carry
 * "which path, expecting what", so one path per credential meant one credential
 * per path. As a widget it is keyed by manufacturer + optional model, which is
 * the axis a check actually varies on: every Axis camera answers the same
 * VAPIX path, and the credential goes back to being only the login. The
 * credential type survives, stripped to authentication (bearer / basic /
 * digest — see utils/httpCheck.ts).
 *
 * Consequence worth knowing: an HTTP check no longer moves `monitorStatus`.
 * It writes a 0/1 to AssetStateSample (alertable through the existing
 * `customStateValue` metric) plus a response-time gauge, so up/down for such a
 * device comes from whatever transport its responseTime stream uses — usually
 * ICMP.
 *
 * The "agent" method represents a Polaris-managed agent installed locally
 * on the target host (Linux/macOS/Windows × amd64/arm64) that pushes samples
 * back to Polaris over HTTPS and holds an outbound WebSocket for on-demand
 * probes. It's incompatible with appliance sources (FortiManager, FortiGate)
 * because Fortinet appliances can't run third-party binaries. See the
 * polaris-agent skill.
 *
 * The "vcenter" method covers FOUR streams (enforced in isMethodValidForStream
 * via VCENTER_STREAMS): responseTime, cpuMemory, interfaces and storage. All
 * four are served from ONE batched SOAP fetch per integration per tick,
 * warm-cached in monitoringService — the asset itself is never contacted. It
 * is the source default for every stream it covers, which is what lets a
 * vCenter fleet be monitored with no credential on the guest, no SNMP enabled
 * on ESXi, and no reachable guest IP.
 *
 * It applies to any asset carrying a vcenter-vm OR vcenter-host AssetSource —
 * INCLUDING assets discovered by AD/Entra/Windows Server that a vCenter sync
 * later merged into (their discoveredByIntegration still points at the
 * directory integration). The matrix therefore allows "vcenter" on those
 * source kinds too; the hard requirement — a vCenter AssetSource row to
 * resolve the integration through — is enforced where it's cheap: the
 * per-asset PUT validation in assets.ts (one lookup) and the collectors
 * themselves (soft error when the asset isn't in the cached inventory).
 * Threading a per-asset "has vcenter source" flag through the hot-loop
 * resolver was rejected — it would cost an AssetSource lookup per asset per
 * tick.
 *
 * One consequence worth knowing: the response-time probe reports the UPSTREAM
 * fetch duration, i.e. the vCenter round trip shared by every asset on that
 * integration, not a measurement of the device. And when vCenter itself cannot
 * be reached the probe is SKIPPED rather than failed (ProbeResult.skipped), so
 * one vCenter outage never declares a whole virtual fleet down.
 *
 * ── The "fortimanager" method (2026-08-28) ───────────────────────────────────
 * Asks FortiManager's own device database whether it still sees the chassis,
 * instead of touching the device. Response-time ONLY (see FORTIMANAGER_STREAMS)
 * and on the `fortimanager` source only — a standalone FortiGate has no FMG to
 * ask.
 *
 * The point is cost. It reads `/dvmdb/adom/<adom>/device`, a NATIVE FMG call:
 * outside the `/sys/proxy/json` concurrency-1 lane, and one request covers the
 * entire managed fleet. A warm cache per integration per tick means ~187 gates
 * cost one round trip, versus 187 serialized proxy calls or 187 direct dials.
 * It also reaches a gate Polaris has no route to, since Polaris only has to
 * reach FortiManager.
 *
 * What it trades away: the reading is FMG's, refreshed on FMG's check-in
 * cadence rather than Polaris's, so it is lagged and second-hand — it says the
 * gate is talking to its manager, not that it is serving traffic. It carries no
 * uptime, so it drives no reboot detection. And FMG holds nothing else worth
 * polling: no CPU, memory, temperature, interface counters or session count,
 * and no live switch/AP status. That is why this is one stream and not a
 * transport.
 *
 * NOT a source default — ICMP stays the default for response time. Repointing
 * it would silently change how up/down is decided for every gate on every FMG
 * install.
 *
 * Locked with the user during the design exchange; see polaris-monitoring-discovery -> polling-methods-streams.md
 * "Polling-method compatibility matrix".
 */

export type PollingMethod = "rest_api" | "snmp" | "winrm" | "ssh" | "icmp" | "disabled" | "agent" | "vcenter" | "fortimanager";

/** Streams resolved independently by the four-tier monitor settings hierarchy. */
export type Stream =
  | "responseTime"
  | "cpuMemory"
  | "temperature"
  | "interfaces"
  | "lldp"
  | "storage"
  | "processes"
  | "eventLog";
export type AssetSourceKind =
  | "fortimanager"
  | "fortigate"
  | "activedirectory"
  | "entraid"
  | "windowsserver"
  | "vcenter"
  | "azurearc"
  | "manual";

const ALL_METHODS: ReadonlyArray<PollingMethod> = ["rest_api", "snmp", "winrm", "ssh", "icmp", "disabled", "agent", "vcenter", "fortimanager"];

// Each entry is the full set of valid methods for that source. A `Set` is
// O(1) lookup which matters for the resolver running in the hot monitor
// loop, even though the cardinality is small. "disabled" is universally
// allowed — it means "do not poll this stream" and applies to any source.
// "agent" is allowed wherever Polaris can install software (everything
// except the Fortinet appliance sources).
const COMPATIBILITY: Readonly<Record<AssetSourceKind, ReadonlySet<PollingMethod>>> = {
  // "fortimanager" (ask FMG's own database, response-time only) is on the FMG
  // source and NOWHERE else — a standalone FortiGate has no FortiManager to
  // ask, and neither does anything non-Fortinet.
  fortimanager:    new Set<PollingMethod>(["rest_api", "snmp", "ssh", "icmp", "disabled", "fortimanager"]),
  fortigate:       new Set<PollingMethod>(["rest_api", "snmp", "ssh", "icmp", "disabled"]),
  // "vcenter" on the directory sources covers VMs those integrations
  // discovered FIRST that a vCenter sync merged into — see header note.
  activedirectory: new Set<PollingMethod>(["icmp", "winrm", "ssh", "disabled", "agent", "vcenter"]),
  entraid:         new Set<PollingMethod>(["icmp", "winrm", "ssh", "disabled", "agent", "vcenter"]),
  windowsserver:   new Set<PollingMethod>(["icmp", "winrm", "ssh", "disabled", "agent", "vcenter"]),
  // Arc-enabled machines are ordinary Windows/Linux hosts, so they take the
  // same set as the directory sources. "vcenter" is included for the same
  // reason it is there — an Arc machine can also be a vCenter-merged VM, and
  // in fact the Arc↔vCenter vmUuid cross-link makes that MORE likely, not
  // less. No rest_api (no shared host API) and no snmp.
  azurearc:        new Set<PollingMethod>(["icmp", "winrm", "ssh", "disabled", "agent", "vcenter"]),
  // Union across the two vCenter classes: VMs are guest OSes (icmp / winrm /
  // ssh / agent like the directory sources), ESXi hosts answer snmp/ssh, and
  // "vcenter" delivers the hypervisor-view cpuMemory stream for VMs.
  vcenter:         new Set<PollingMethod>(["icmp", "snmp", "winrm", "ssh", "disabled", "agent", "vcenter"]),
  // Spelled out rather than `ALL_METHODS`. Manual is the most permissive set
  // by design (the operator picks the credential), but "most permissive" is not
  // "everything that exists": `fortimanager` reads a specific integration's
  // device roster, and an orphan asset has no integration to read. Writing the
  // list out means a future method has to be added here deliberately instead of
  // being inherited by accident.
  manual:          new Set<PollingMethod>(["rest_api", "snmp", "winrm", "ssh", "icmp", "disabled", "agent", "vcenter"]),
};

/**
 * Convert an Integration.type string into the AssetSourceKind we use here.
 * Unknown integration types map to "manual" (no source-specific tokens to
 * lean on, so the most permissive matrix applies).
 */
/**
 * True when the integration type is one of the two Fortinet transports
 * (FortiManager / standalone FortiGate). The pair share every FortiOS
 * pathway (discovery, DHCP push, quarantine, description sync, monitoring
 * credentials) — this predicate replaces the `=== "fortimanager" ||
 * === "fortigate"` literal pair that was retyped ~20 times.
 */
export function isFortinetIntegrationType(t: string | null | undefined): boolean {
  return t === "fortimanager" || t === "fortigate";
}

export function assetSourceKindFromIntegrationType(integrationType: string | null | undefined): AssetSourceKind {
  if (!integrationType) return "manual";
  switch (integrationType) {
    case "fortimanager":    return "fortimanager";
    case "fortigate":       return "fortigate";
    case "activedirectory": return "activedirectory";
    case "entraid":         return "entraid";
    case "windowsserver":   return "windowsserver";
    case "vcenter":         return "vcenter";
    case "azurearc":        return "azurearc";
    default:                return "manual";
  }
}

// Per-stream method restrictions for streams that genuinely cannot use every
// method their source otherwise allows. Streams NOT listed here impose no
// per-stream restriction (only the source matrix above + the responseTime-only
// ICMP rule in the routes apply), preserving pre-existing behavior for the six
// original streams. The two cross-transport streams:
//   processes — agent/SNMP (hrSWRunTable)/SSH (ps,tasklist)/WinRM (Get-Process).
//               No REST (no host-process FortiOS endpoint) and no ICMP.
//   eventLog  — agent/SSH (journalctl,Get-WinEvent)/WinRM (Get-WinEvent)/REST
//               (FortiOS device log API). No SNMP (no MIB) and no ICMP.
// "disabled" is always allowed (means "don't poll this stream").
const STREAM_METHODS: Partial<Record<Stream, ReadonlySet<PollingMethod>>> = {
  processes: new Set<PollingMethod>(["agent", "snmp", "ssh", "winrm", "disabled"]),
  eventLog:  new Set<PollingMethod>(["agent", "ssh", "winrm", "rest_api", "disabled"]),
};

/** True when `method` is a valid polling method for the given asset source. */
export function isPollingMethodCompatible(source: AssetSourceKind, method: PollingMethod): boolean {
  return COMPATIBILITY[source].has(method);
}

/**
 * True when `method` is valid for `stream`. Streams without an explicit
 * restriction allow any method (the source matrix + route-level ICMP rule
 * still apply). Used by the resolver, the monitorSettings routes, and the UI
 * to gate the cross-transport streams (processes / eventLog).
 *
 * The "vcenter" method is valid for the four streams the vCenter server can
 * actually answer: responseTime (VM power state / ESXi connection state),
 * cpuMemory, interfaces (guest vNICs / host pNICs + VMkernel ports) and
 * storage (guest filesystems / host-mounted datastores). It is NOT valid for
 * temperature, LLDP, processes or event log — vCenter publishes nothing for
 * those. (Expressed as a method-level guard rather than per-stream
 * STREAM_METHODS entries so the unrestricted streams keep allowing every other
 * method.)
 */
export const VCENTER_STREAMS: ReadonlySet<Stream> = new Set<Stream>([
  "responseTime", "cpuMemory", "interfaces", "storage",
]);

/**
 * Streams the "fortimanager" method can serve: response time, and only that.
 *
 * FortiManager is a configuration manager, not a metrics store. Its device
 * database carries reachability (`conn_status`, `ha_slave[].status`), identity
 * and firmware — there is no CPU, memory, temperature, interface counter or
 * session count in it anywhere, and no live switch/AP status either (those are
 * FortiOS monitor endpoints, which is why they go through the proxy or direct).
 * So the method answers exactly one question, "does FMG still see this chassis",
 * and is scoped to the one stream that asks it.
 */
export const FORTIMANAGER_STREAMS: ReadonlySet<Stream> = new Set<Stream>(["responseTime"]);

export function isMethodValidForStream(stream: Stream, method: PollingMethod): boolean {
  if (method === "vcenter") return VCENTER_STREAMS.has(stream);
  if (method === "fortimanager") return FORTIMANAGER_STREAMS.has(stream);
  const allowed = STREAM_METHODS[stream];
  return allowed ? allowed.has(method) : true;
}

/** Methods valid for `stream`, in display order. Empty restriction → all methods. */
export function methodsForStream(stream: Stream): ReadonlyArray<PollingMethod> {
  return ALL_METHODS.filter((m) => isMethodValidForStream(stream, m));
}

/** Returns the methods valid for `source`, in display order (matches ALL_METHODS). */
export function compatibleMethodsFor(source: AssetSourceKind): ReadonlyArray<PollingMethod> {
  const allowed = COMPATIBILITY[source];
  return ALL_METHODS.filter((m) => allowed.has(m));
}

/** All polling-method values, in display order. Useful for UI dropdowns. */
export function allPollingMethods(): ReadonlyArray<PollingMethod> {
  return ALL_METHODS;
}

/** Type guard — narrows arbitrary input to PollingMethod when valid. */
export function isPollingMethod(v: unknown): v is PollingMethod {
  return typeof v === "string" && (ALL_METHODS as ReadonlyArray<string>).includes(v);
}

/**
 * Should a response-time probe be QUEUED for an asset whose resolved
 * responseTimePolling is `method`?
 *
 * Only "don't poll" values are excluded. `"agent"` deliberately still queues:
 * `probeAsset` returns a synthetic success for it so the probe counter keeps
 * incrementing under transport="agent", and `recordProbeResult` early-returns
 * before touching the DB — dropping it here would silently change that metric.
 *
 * Exists as a shared pure predicate because its two callers — `computeDueWork`
 * in monitoringService and the pg-boss publisher in jobs/monitorAssets — are a
 * REQUIRED LOCKSTEP PAIR (polaris-change-impact -> cross-cutting/polling-method-resolver.md), and this gate was previously absent from
 * both: every other stream checked its resolved method before publishing, the
 * probe did not, and `"disabled"` therefore fell through probeAsset's dispatch
 * to the unknown-method error and was recorded as a failed poll. An operator
 * switching Response Time off manufactured an outage.
 */
export function responseTimeProbeShouldQueue(method: PollingMethod | string | null | undefined): boolean {
  return !!method && method !== "disabled";
}

/** Operator-friendly label for a polling method. */
export function pollingMethodLabel(method: PollingMethod): string {
  switch (method) {
    case "rest_api": return "REST API";
    case "snmp":     return "SNMP";
    case "winrm":    return "WinRM";
    case "ssh":      return "SSH";
    case "icmp":     return "ICMP";
    case "disabled": return "Disabled";
    case "agent":    return "Polaris Agent";
    case "vcenter":  return "vCenter";
    case "fortimanager": return "FortiManager";
  }
}

/**
 * Which credential TYPE a polling method needs, or null when it needs none.
 *
 * ICMP carries no auth; "disabled" polls nothing; "agent" authenticates with
 * the agent's own enrollment bearer; "vcenter" and "fortimanager" read a
 * batched fetch that authenticates with the INTEGRATION's credential, not the
 * asset's. Those five take no per-asset credential at all, so a credential
 * assigned alongside them is dead config rather than a contradiction — callers
 * skip the check instead of refusing (an operator may be staging a credential
 * before flipping the method).
 *
 * The browser mirror is `_credTypeForPolling` in public/js/assets.js (and
 * `_credtypeForMethod` in the class-override modal); keep all three in step —
 * see polaris-change-impact -> cross-cutting/polling-method-resolver.md,
 * "If adding a new polling method".
 */
export function credentialTypeForPollingMethod(
  method: PollingMethod,
): "snmp" | "winrm" | "ssh" | "restapi" | null {
  switch (method) {
    case "snmp":     return "snmp";
    case "winrm":    return "winrm";
    case "ssh":      return "ssh";
    case "rest_api": return "restapi";
    case "icmp":
    case "disabled":
    case "agent":
    case "vcenter":
    case "fortimanager":
      return null;
  }
}
