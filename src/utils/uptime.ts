/**
 * src/utils/uptime.ts — device-uptime helpers.
 *
 * Uptime is captured on the probe path (SNMP sysUpTime / FortiOS system
 * status / Polaris Agent host.Uptime) and stored on Asset.lastUptimeSec.
 * These pure helpers convert raw probe values into seconds and render a
 * compact human-readable duration. snmpTicksToSeconds feeds the SNMP probe
 * capture in monitoringService; the frontend keeps a mirror of formatUptime()
 * in public/js/app.js (vanilla JS, no module imports).
 */

/**
 * Convert SNMP sysUpTime / hrSystemUptime TimeTicks (hundredths of a second)
 * to whole seconds. Returns null for non-finite / negative input.
 *
 * Note: sysUpTime is a 32-bit counter that wraps at ~497 days and resets when
 * the SNMP agent (not necessarily the device) restarts — acceptable for a
 * "current uptime" display.
 */
export function snmpTicksToSeconds(ticks: unknown): number | null {
  if (ticks == null || ticks === "") return null; // Number(null) is 0, not NaN
  const n = typeof ticks === "number" ? ticks : Number(ticks);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n / 100);
}

/**
 * Render a duration in seconds as a compact "Nd Nh" / "Nh Nm" / "Nm" string.
 * Shows the two most-significant non-zero units. Sub-minute reads as "<1m".
 * Returns "—" for null / negative input.
 */
export function formatUptime(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—";
  const s = Math.floor(seconds);
  if (s < 60) return "<1m";

  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);

  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  return `${mins}m`;
}

/**
 * Render a duration in seconds at full precision — every unit from the
 * most-significant non-zero one down to seconds ("18d 3h 21m 15s", "6m 57s",
 * "47s"). Intermediate zero units are kept ("1d 0h 0m 1s") so the string is
 * never read as a gap; only leading zero units are dropped.
 *
 * Unlike formatUptime (a compact two-unit display for the assets table), this
 * keeps the seconds — it backs the device.reboot Event message, where the
 * post-reboot uptime is routinely under a minute and "<1m" would erase the
 * only interesting number in the line.
 *
 * Returns "—" for null / negative input, matching formatUptime.
 */
export function formatUptimeLong(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—";
  const s = Math.floor(seconds);

  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (parts.length || hours > 0) parts.push(`${hours}h`);
  if (parts.length || mins > 0) parts.push(`${mins}m`);
  parts.push(`${secs}s`);
  return parts.join(" ");
}

/**
 * A device's uptime as the asset's System tab shows it, for readers that are
 * not the browser (the AI assistant's list_assets and asset_details).
 * lastUptimeSec is the reading at the last probe (lastMonitorAt); it is
 * carried forward to `now` unless the device is down, since a dead box's
 * uptime should not keep climbing. upSince prefers the reboot Polaris
 * detected (lastRebootAt), else the boot instant the reading implies.
 * Null when the probe path never reported uptime (ICMP / SSH / WinRM only).
 */
export function deviceUptime(
  a: { lastUptimeSec?: number | null; lastMonitorAt?: Date | null; lastRebootAt?: Date | null; monitorStatus?: string | null },
  now: number = Date.now(),
): { uptimeSec: number; uptime: string; upSince: Date } | null {
  if (a.lastUptimeSec == null || !a.lastMonitorAt) return null;
  const observedAt = a.lastMonitorAt.getTime();
  const elapsed = Math.max(0, Math.floor((now - observedAt) / 1000));
  const uptimeSec = a.monitorStatus === "down" ? a.lastUptimeSec : a.lastUptimeSec + elapsed;
  const upSince = a.lastRebootAt ?? new Date(observedAt - a.lastUptimeSec * 1000);
  return { uptimeSec, uptime: formatUptime(uptimeSec), upSince };
}
