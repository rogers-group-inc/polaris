/**
 * src/utils/assetSourceState.ts
 *
 * "What does THIS source say about whether the device is enabled?"
 *
 * Every discovery source records its own view of an asset in
 * `AssetSource.observed`, and several of them independently report a
 * lifecycle/availability state under a different field name and vocabulary:
 * Entra says `accountEnabled: false`, AD says `accountDisabled: true`,
 * vCenter says `powerState: "POWERED_OFF"`, a FortiGate says its managed
 * switch is `connected: false`. Rendered raw in the Sources tab's key/value
 * table those read as unrelated trivia, and the one question an operator
 * actually asks — *which* source is calling this device disabled? — takes
 * cross-referencing four vocabularies to answer.
 *
 * This is the single place that normalizes them into one tri-state verdict
 * per source, so the desktop Sources tab and the mobile asset sheet render
 * the same badge from the same rule set. Pure — the caller passes the raw
 * `observed` blob.
 *
 * Two deliberate distinctions:
 *
 *   - `kind` separates an ADMINISTRATIVE statement ("account") from a runtime
 *     one ("runtime"). A directory-disabled account and a powered-off VM are
 *     both "not enabled", but only the first is a lifecycle decision someone
 *     made — so only `account` readings are compared for disagreement.
 *     (A directory-disabled account is what decommissions the asset; see the
 *     status mapping in discoveryEngine's Entra sync.)
 *   - `unknown` means the source doesn't report a state AT ALL, which is
 *     itself the answer to "which sources show this?" — it is never a stand-in
 *     for "enabled". Most Fortinet endpoint sightings and Intune land here.
 */

export type AssetSourceStateValue = "enabled" | "disabled" | "unknown";

export interface AssetSourceStateReading {
  /** Tri-state verdict. `unknown` = this source reports no state. */
  state: AssetSourceStateValue;
  /**
   * `account`  — administratively enabled/disabled (Entra, AD).
   * `runtime`  — powered on/off, connected/disconnected (vCenter, Fortinet).
   * `none`     — no state reported.
   */
  kind: "account" | "runtime" | "none";
  /** Badge text, worded in the source's own vocabulary ("Powered off"). */
  label: string;
  /** `observed` field the verdict came from — named in the badge tooltip. */
  field: string | null;
  /** Raw value as the source reported it, for the tooltip. */
  value: string | null;
}

const NOT_REPORTED: AssetSourceStateReading = {
  state: "unknown",
  kind: "none",
  label: "State not reported",
  field: null,
  value: null,
};

function reading(
  state: AssetSourceStateValue,
  kind: "account" | "runtime",
  label: string,
  field: string,
  value: unknown,
): AssetSourceStateReading {
  return { state, kind, label, field, value: value === null || value === undefined ? null : String(value) };
}

function bool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Normalize one source's observed blob into its enabled/disabled verdict.
 * Unrecognized source kinds, and recognized kinds whose state field is
 * missing or holds a value we don't have a mapping for, return "not
 * reported" rather than guessing.
 */
export function deriveAssetSourceState(
  sourceKind: string,
  observed: unknown,
): AssetSourceStateReading {
  const o = (observed && typeof observed === "object" && !Array.isArray(observed))
    ? (observed as Record<string, unknown>)
    : null;
  if (!o) return NOT_REPORTED;

  switch (sourceKind) {
    case "entra": {
      const enabled = bool(o.accountEnabled);
      if (enabled === null) return NOT_REPORTED;
      return reading(enabled ? "enabled" : "disabled", "account", enabled ? "Enabled" : "Disabled", "accountEnabled", enabled);
    }

    case "ad": {
      // AD carries the inverted field — `accountDisabled` mirrors the
      // userAccountControl ACCOUNTDISABLE bit.
      const disabled = bool(o.accountDisabled);
      if (disabled === null) return NOT_REPORTED;
      return reading(disabled ? "disabled" : "enabled", "account", disabled ? "Disabled" : "Enabled", "accountDisabled", disabled);
    }

    case "vcenter-vm": {
      const power = str(o.powerState).toUpperCase();
      if (power === "POWERED_ON")  return reading("enabled",  "runtime", "Powered on",  "powerState", o.powerState);
      if (power === "POWERED_OFF") return reading("disabled", "runtime", "Powered off", "powerState", o.powerState);
      if (power === "SUSPENDED")   return reading("disabled", "runtime", "Suspended",   "powerState", o.powerState);
      return NOT_REPORTED;
    }

    case "vcenter-host": {
      // connectionState is the more meaningful signal for an ESXi host — a
      // host can be powered on but disconnected from vCenter. Fall back to
      // powerState only when the connection state is absent.
      const conn = str(o.connectionState).toUpperCase();
      if (conn === "CONNECTED")      return reading("enabled",  "runtime", "Connected",      "connectionState", o.connectionState);
      if (conn === "DISCONNECTED")   return reading("disabled", "runtime", "Disconnected",   "connectionState", o.connectionState);
      if (conn === "NOT_RESPONDING") return reading("disabled", "runtime", "Not responding", "connectionState", o.connectionState);
      const power = str(o.powerState).toUpperCase();
      if (power === "POWERED_ON")  return reading("enabled",  "runtime", "Powered on",  "powerState", o.powerState);
      if (power === "POWERED_OFF") return reading("disabled", "runtime", "Powered off", "powerState", o.powerState);
      if (power === "STANDBY")     return reading("disabled", "runtime", "Standby",     "powerState", o.powerState);
      return NOT_REPORTED;
    }

    case "unraid-vm":
    case "unraid-container":
    case "truenas-vm":
    case "truenas-app":
    case "proxmox-qemu":
    case "proxmox-lxc": {
      // Normalized by the workload services to running / stopped / paused /
      // other (services/workloadSync.ts → normalizeWorkloadState).
      const state = str(o.state).toLowerCase();
      if (state === "running") return reading("enabled",  "runtime", "Running", "state", o.state);
      if (state === "stopped") return reading("disabled", "runtime", "Stopped", "state", o.state);
      if (state === "paused")  return reading("disabled", "runtime", "Paused",  "state", o.state);
      return NOT_REPORTED;
    }

    case "arc": {
      // Arc's connectivity status is a RUNTIME statement — it means the
      // Connected Machine agent is (or isn't) checking in with Azure. It is
      // deliberately not an "account" reading: unlike a directory-disabled
      // account, a Disconnected agent is a reachability fact and never
      // decommissions the asset.
      const status = str(o.status);
      if (/^connected$/i.test(status))             return reading("enabled",  "runtime", "Connected",    "status", o.status);
      if (/^disconnected$/i.test(status))          return reading("disabled", "runtime", "Disconnected", "status", o.status);
      if (/^expired$/i.test(status))               return reading("disabled", "runtime", "Expired",      "status", o.status);
      return NOT_REPORTED;
    }

    case "arc-k8s": {
      const conn = str(o.connectivityStatus);
      if (/^connected$/i.test(conn))               return reading("enabled",  "runtime", "Connected",    "connectivityStatus", o.connectivityStatus);
      if (/^(disconnected|offline)$/i.test(conn))  return reading("disabled", "runtime", "Disconnected", "connectivityStatus", o.connectivityStatus);
      if (/^expired$/i.test(conn))                 return reading("disabled", "runtime", "Expired",      "connectivityStatus", o.connectivityStatus);
      return NOT_REPORTED;
    }

    case "fortiswitch": {
      const connected = bool(o.connected);
      if (connected === null) return NOT_REPORTED;
      return reading(connected ? "enabled" : "disabled", "runtime", connected ? "Connected" : "Disconnected", "connected", connected);
    }

    case "fortiap": {
      // FortiOS firmware variance: most releases report "online", some
      // "connected" (mirrors isFortiapStatusOnline in fortiapMonitorRow).
      // Admission states like "discovered" are neither up nor down, so they
      // stay unreported rather than being painted red.
      const status = str(o.status);
      if (/^(online|connected)$/i.test(status))      return reading("enabled",  "runtime", "Online",  "status", o.status);
      if (/^(offline|disconnected)$/i.test(status))  return reading("disabled", "runtime", "Offline", "status", o.status);
      return NOT_REPORTED;
    }

    // intune / fortigate-firewall / fortigate-endpoint / polaris-agent /
    // manual report no lifecycle state of their own — a sighting is presence
    // evidence, not an enabled/disabled statement.
    default:
      return NOT_REPORTED;
  }
}

/**
 * True when two or more `account`-kind sources disagree about the asset — the
 * case worth calling out on the Sources tab, since a directory-disabled
 * account decommissions the asset while another directory still says it's
 * live. Runtime readings are excluded: a powered-off VM whose AD account is
 * enabled is not a contradiction.
 */
export function hasAccountStateDisagreement(readings: AssetSourceStateReading[]): boolean {
  const states = new Set(
    readings.filter((r) => r.kind === "account").map((r) => r.state),
  );
  return states.has("enabled") && states.has("disabled");
}
