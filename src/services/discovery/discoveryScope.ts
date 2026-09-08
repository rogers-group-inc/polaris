/**
 * src/services/discovery/discoveryScope.ts
 *
 * How a discovery run is narrowed to ONE device, and the rules about which
 * integration type each narrowing is valid for.
 *
 * Pure — no prisma, no service imports — so the queue payload, the engine, the
 * collectors and the per-asset resolver can all share one definition without an
 * import cycle.
 *
 * WHY A UNION rather than the string `scopeDeviceName` it replaced: every
 * consumer must make a per-kind decision, and a union turns "you added a scope
 * kind and forgot the vCenter branch" into a compile error instead of a scope
 * that is silently ignored at runtime. `scopeDeviceName` survives only as the
 * DiscoveryRun DISPLAY column (`scopeLabel` below feeds it), because that is
 * what the Integrations card renders and what the asset button compares against.
 *
 * ⚠️ Adding a kind is a THREE-part change, not one:
 *   1. the union here + `SCOPE_INTEGRATION_TYPE`,
 *   2. a target parameter on that integration's collector,
 *   3. a guarantee that the sync layer takes NO absence-based destructive
 *      action on a one-device result.
 * Skipping (3) is how a "refresh this asset" click decommissions a fleet. See
 * the audit note on `syncEntraDevices` / `syncActiveDirectoryDevices` below.
 */

/** A discovery run narrowed to a single device. */
export type DiscoveryScope =
  /** One FortiGate in a FortiManager ADOM roster, by its FMG/dvmdb name. */
  | { kind: "fmg-device"; deviceName: string }
  /** One Entra-registered device, by its stable Entra `deviceId` GUID. */
  | { kind: "entra-device"; deviceId: string }
  /** One AD computer object, by its `objectGUID` (lowercase wire-order hex).
   *  Keyed on the GUID rather than the DN deliberately: a computer object that
   *  moves OU keeps its GUID but changes its DN. */
  | { kind: "ad-object"; objectGuid: string }
  /** One vCenter VM, by managed-object reference (e.g. "vm-1024"). */
  | { kind: "vcenter-vm"; moref: string }
  /** One ESXi host, by managed-object reference (e.g. "host-42"). */
  | { kind: "vcenter-host"; moref: string }
  /** One Arc-enabled machine, by its full ARM resource id. */
  | { kind: "arc-machine"; resourceId: string };

/** The ONE integration type each scope kind is valid against. */
export const SCOPE_INTEGRATION_TYPE: Record<DiscoveryScope["kind"], string> = {
  "fmg-device": "fortimanager",
  "entra-device": "entraid",
  "ad-object": "activedirectory",
  "vcenter-vm": "vcenter",
  "vcenter-host": "vcenter",
  "arc-machine": "azurearc",
};

/** Is this scope usable against this integration type? */
export function scopeMatchesIntegrationType(scope: DiscoveryScope, integrationType: string): boolean {
  return SCOPE_INTEGRATION_TYPE[scope.kind] === integrationType;
}

/**
 * The operator-facing label for a scoped run — stamped on `DiscoveryRun.
 * scopeDeviceName`, rendered by the Integrations card as "Discovering <x>…",
 * and compared (case-insensitively) by the asset button to decide whether the
 * in-flight run is THIS asset's.
 *
 * For FMG that is the device name, which is genuinely what an operator would
 * recognise. For the directory types the identifier is a GUID — ugly, but it is
 * the only stable identity the run has at this layer, and a wrong-but-friendly
 * label (a hostname that no longer matches) would be worse than an opaque one.
 * Callers with a display name to hand should pass `displayName`.
 */
export function scopeLabel(scope: DiscoveryScope | undefined, displayName?: string | null): string | undefined {
  if (!scope) return undefined;
  if (displayName && displayName.trim()) return displayName.trim();
  switch (scope.kind) {
    case "fmg-device": return scope.deviceName;
    case "entra-device": return scope.deviceId;
    case "ad-object": return scope.objectGuid;
    case "vcenter-vm": return scope.moref;
    case "vcenter-host": return scope.moref;
    case "arc-machine": return scope.resourceId;
  }
}

/**
 * The vCenter target, or null when this scope isn't a vCenter one.
 *
 * A helper rather than an inline ternary at the call site because BOTH vCenter
 * kinds map to the same collector argument, and a call site that handled only
 * `vcenter-vm` would silently run a host refresh as a FULL inventory read —
 * which is precisely the fleet-scale accident the union exists to prevent.
 */
export function vcenterScopeTarget(
  scope: DiscoveryScope | undefined,
): { kind: "vm" | "host"; moref: string } | undefined {
  if (scope?.kind === "vcenter-vm") return { kind: "vm", moref: scope.moref };
  if (scope?.kind === "vcenter-host") return { kind: "host", moref: scope.moref };
  return undefined;
}

/**
 * AD `objectGUID` is a binary attribute: an LDAP filter must present it as
 * escaped bytes (`\4c\a2…`), not as the hex string or a dashed GUID.
 *
 * `decodeObjectGuid` (ldapClient.ts) stores the 16 raw bytes as lowercase hex in
 * WIRE ORDER with no byte-swapping, so this is a straight pairwise re-escape —
 * no endianness dance. That symmetry is the whole reason a scoped AD search is
 * safe to key on the GUID; `tests/unit/discoveryScope.test.ts` pins the round
 * trip, because a byte-order slip here would match zero objects and read as
 * "Discover Now silently does nothing".
 *
 * Returns null for anything that isn't exactly 32 hex characters, so a
 * malformed stored GUID can never build a filter that matches the wrong object.
 */
export function ldapGuidFilterValue(guidHex: string): string | null {
  const hex = String(guidHex || "").trim().toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) return null;
  return (hex.match(/../g) as string[]).map((b) => `\\${b}`).join("");
}
