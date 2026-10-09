/**
 * src/utils/workloadSources.ts
 *
 * The vocabulary the workload integrations (Unraid, TrueNAS SCALE, Proxmox VE)
 * share: their AssetSource kinds per role, and the predicates every guard,
 * collector and sync pass uses to go from one to the other. One place, so the
 * polling PUT guard, the collectors' integration lookup and the disappearance
 * sweep cannot disagree about which source rows belong to which platform.
 *
 *   role       Unraid              TrueNAS SCALE      Proxmox VE       Asset.assetType
 *   host       unraid-host         truenas-host       proxmox-node     hypervisor
 *   vm         unraid-vm           truenas-vm         proxmox-qemu     server
 *   container  unraid-container    truenas-app        proxmox-lxc      container
 *
 * A TrueNAS "container" asset is an App (a compose project, possibly several
 * Docker containers) — the unit TrueNAS itself starts, stops and upgrades.
 * Proxmox is the one clustered platform: one integration, many hosts (nodes).
 */

export type WorkloadPlatform = "unraid" | "truenas" | "proxmox";
export type WorkloadRole = "host" | "vm" | "container";

export const WORKLOAD_PLATFORMS: ReadonlyArray<WorkloadPlatform> = ["unraid", "truenas", "proxmox"];

const KINDS: Readonly<Record<WorkloadPlatform, Readonly<Record<WorkloadRole, string>>>> = {
  unraid:  { host: "unraid-host",  vm: "unraid-vm",  container: "unraid-container" },
  truenas: { host: "truenas-host", vm: "truenas-vm", container: "truenas-app" },
  proxmox: { host: "proxmox-node", vm: "proxmox-qemu", container: "proxmox-lxc" },
};

const LABELS: Readonly<Record<WorkloadPlatform, string>> = {
  unraid: "Unraid",
  truenas: "TrueNAS SCALE",
  proxmox: "Proxmox VE",
};

export function isWorkloadPlatform(v: unknown): v is WorkloadPlatform {
  return typeof v === "string" && (WORKLOAD_PLATFORMS as readonly string[]).includes(v);
}

/** The AssetSource.sourceKind for a platform + role. */
export function workloadSourceKind(platform: WorkloadPlatform, role: WorkloadRole): string {
  return KINDS[platform][role];
}

/** Every source kind one platform writes, in role order host → vm → container. */
export function workloadSourceKindsFor(platform: WorkloadPlatform): string[] {
  const k = KINDS[platform];
  return [k.host, k.vm, k.container];
}

/** Every workload source kind across both platforms. */
export const ALL_WORKLOAD_SOURCE_KINDS: ReadonlyArray<string> =
  WORKLOAD_PLATFORMS.flatMap((p) => workloadSourceKindsFor(p));

/** Parse a source kind back to its platform + role, or null for any other kind. */
export function parseWorkloadSourceKind(
  kind: string | null | undefined,
): { platform: WorkloadPlatform; role: WorkloadRole } | null {
  if (!kind) return null;
  for (const platform of WORKLOAD_PLATFORMS) {
    const k = KINDS[platform];
    if (kind === k.host) return { platform, role: "host" };
    if (kind === k.vm) return { platform, role: "vm" };
    if (kind === k.container) return { platform, role: "container" };
  }
  return null;
}

/** The asset type a discovered workload of `role` is created as. */
export function assetTypeForWorkloadRole(role: WorkloadRole): "hypervisor" | "server" | "container" {
  return role === "host" ? "hypervisor" : role === "vm" ? "server" : "container";
}

/** Operator-facing platform name. */
export function workloadPlatformLabel(platform: WorkloadPlatform): string {
  return LABELS[platform];
}

/** What the platform calls its container role: a TrueNAS App is a compose project, not one container. */
export function workloadContainerNoun(platform: WorkloadPlatform): string {
  return platform === "truenas" ? "App" : "Container";
}

// ─── Identity + state (pure; shared by the sync, the services and the collectors) ─

/** running / stopped / paused / other — the four states the rest of Polaris reads. */
export type WorkloadState = "running" | "stopped" | "paused" | "other";

/** Map a platform's state word to the four states the rest of Polaris reads. */
export function normalizeWorkloadState(raw: string | null | undefined): WorkloadState {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return "other";
  // Unraid: RUNNING / EXITED / PAUSED (containers), RUNNING / SHUTOFF / PAUSED /
  // PMSUSPENDED (VMs). TrueNAS: RUNNING / STOPPED / DEPLOYING / CRASHED (apps),
  // RUNNING / STOPPED / SUSPENDED (VMs).
  if (s === "running" || s === "started" || s === "up") return "running";
  if (s === "exited" || s === "stopped" || s === "shutoff" || s === "shutdown" || s === "crashed" || s === "dead" || s === "created")
    return "stopped";
  if (s === "paused" || s === "suspended" || s === "pmsuspended") return "paused";
  return "other";
}

/**
 * A host. A single-host platform (Unraid, TrueNAS) passes no key: its one host
 * is `${integrationId}:host`, as it always was. A clustered platform passes
 * the node's name, which is stable across the cluster's lifetime.
 */
export function workloadHostExternalId(integrationId: string, hostKey?: string | null): string {
  return hostKey ? `${integrationId}:node:${hostKey}` : `${integrationId}:host`;
}

/** The key a host's usage is filed under in a WorkloadSnapshot — "" for a single-host platform. */
export function workloadHostUsageKey(hostKey: string | null | undefined): string {
  return hostKey ?? "";
}

/** A VM: its UUID when the platform reports a real one, else integration + name. */
export function workloadVmExternalId(integrationId: string, vm: { uuid: string | null; name: string }): string {
  const uuid = (vm.uuid ?? "").trim().toLowerCase();
  // An all-zero UUID is a hypervisor placeholder, not an identity.
  if (uuid && !/^[0-]+$/.test(uuid)) return uuid;
  return `${integrationId}:vm:${vm.name}`;
}

/** A container / App: integration + NAME — never the container id, which changes on every recreate. */
export function workloadContainerExternalId(integrationId: string, name: string): string {
  return `${integrationId}:ctr:${name}`;
}

/**
 * The key a container's externalId is built from: its `identityKey` when the
 * platform sets one (a Proxmox LXC's VMID — LXC hostnames need not be unique
 * and a VMID survives a rename), else its name.
 */
export function workloadContainerKey(c: { name: string; identityKey?: string | null }): string {
  return c.identityKey ?? c.name;
}
