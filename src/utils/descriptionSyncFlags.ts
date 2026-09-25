/**
 * src/utils/descriptionSyncFlags.ts — the per-device-class Description Sync
 * toggles on a FortiManager / standalone FortiGate integration config.
 *
 * Description sync (rule 14) is gated per device class:
 *   - `syncFortigateDescriptions` — the FortiGate's own alias + interface comments
 *   - `syncSwitchDescriptions`    — managed FortiSwitch description + port descriptions
 *   - `syncApDescriptions`        — managed FortiAP wtp `location`
 *
 * These replaced the single `syncDescriptions` master toggle. A class whose key
 * has never been written inherits the legacy `syncDescriptions` value, so an
 * install upgraded with sync ON keeps syncing every class until an operator
 * saves the Description Sync tab (which writes all three keys explicitly).
 */

export type DescriptionSyncRole = "fortigate" | "fortiswitch" | "fortiap";

export interface DescriptionSyncFlags {
  fortigate: boolean;
  fortiswitch: boolean;
  fortiap: boolean;
}

export const DESCRIPTION_SYNC_CONFIG_KEYS: Record<DescriptionSyncRole, string> = {
  fortigate: "syncFortigateDescriptions",
  fortiswitch: "syncSwitchDescriptions",
  fortiap: "syncApDescriptions",
};

export function descriptionSyncFlags(config: unknown): DescriptionSyncFlags {
  const cfg = (config && typeof config === "object" ? config : {}) as Record<string, unknown>;
  const legacy = cfg.syncDescriptions === true;
  const flag = (role: DescriptionSyncRole): boolean => {
    const v = cfg[DESCRIPTION_SYNC_CONFIG_KEYS[role]];
    return typeof v === "boolean" ? v : legacy;
  };
  return { fortigate: flag("fortigate"), fortiswitch: flag("fortiswitch"), fortiap: flag("fortiap") };
}

/** Whether description sync applies to a device of `role`. Unknown role → false. */
export function descriptionSyncEnabledForRole(config: unknown, role: string | null | undefined): boolean {
  if (role !== "fortigate" && role !== "fortiswitch" && role !== "fortiap") return false;
  return descriptionSyncFlags(config)[role];
}

/** Whether any device class syncs — the cheap gate for the discovery reconcile. */
export function anyDescriptionSyncEnabled(config: unknown): boolean {
  const f = descriptionSyncFlags(config);
  return f.fortigate || f.fortiswitch || f.fortiap;
}
