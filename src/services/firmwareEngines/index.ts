/**
 * src/services/firmwareEngines/index.ts — which engine, if any, can flash a
 * given device.
 *
 * Fortinet only, for now: a FortiSwitch (assetType "switch" + an S…/FS…/FR…
 * serial) or a FortiAP (assetType "access_point" + an FP…/PU…/PS… serial),
 * each over its own HTTPS UI. Any other manufacturer's images may be STORED in
 * the repository, but no upgrade is offered — the asset panel says so.
 */

import { normalizeManufacturer } from "../../utils/manufacturerNormalize.js";
import { isFortiSwitchSerial, isFortiApSerial } from "../../utils/firmwareVersion.js";
import type { FirmwareEngine, FirmwareEngineKind } from "./types.js";
import { upgradeFortiSwitch } from "./fortiswitchHttps.js";
import { upgradeFortiAp } from "./fortiapHttps.js";

export type { FirmwareEngineKind } from "./types.js";

export interface ResolvedFirmwareEngine {
  kind: FirmwareEngineKind;
  label: string;
  run: FirmwareEngine;
}

const ENGINES: Record<FirmwareEngineKind, ResolvedFirmwareEngine> = {
  "fortiswitch-https": { kind: "fortiswitch-https", label: "FortiSwitch (HTTPS)", run: upgradeFortiSwitch },
  "fortiap-https":     { kind: "fortiap-https",     label: "FortiAP (HTTPS)",     run: upgradeFortiAp },
};

function isFortinet(manufacturer: string | null | undefined): boolean {
  if (!manufacturer) return false;
  const canon = normalizeManufacturer(manufacturer) ?? manufacturer;
  return /^fortinet\b/i.test(canon.trim());
}

/**
 * The engine for a device, or null when Polaris has none for it. Decided from
 * the manufacturer, the device type and the SERIAL — never the model string.
 */
export function engineFor(manufacturer: string | null | undefined, assetType: string | null | undefined, serial: string | null | undefined): ResolvedFirmwareEngine | null {
  if (!isFortinet(manufacturer)) return null;
  if (assetType === "switch" && isFortiSwitchSerial(serial)) return ENGINES["fortiswitch-https"];
  if (assetType === "access_point" && isFortiApSerial(serial)) return ENGINES["fortiap-https"];
  return null;
}

/**
 * The engine a device TYPE would use for a manufacturer, ignoring the serial —
 * for the Repository tree, which labels a device-type node before any
 * particular device is in question.
 */
export function engineKindForType(manufacturer: string | null | undefined, assetType: string): FirmwareEngineKind | null {
  if (!isFortinet(manufacturer)) return null;
  if (assetType === "switch") return "fortiswitch-https";
  if (assetType === "access_point") return "fortiap-https";
  return null;
}

export function engineByKind(kind: string): ResolvedFirmwareEngine | null {
  return (ENGINES as Record<string, ResolvedFirmwareEngine>)[kind] ?? null;
}
