/**
 * src/utils/sampleAlertDevice.ts — the MADE-UP device an automation test alert
 * is about (business rule 65).
 *
 * A "Send Test Email" used to fire against a real monitored asset, on the
 * reasoning that a test should look exactly like the real thing. What it
 * actually produced was an email carrying a real hostname, a real management
 * IP, a real site code and the device's own admin description — mailed on
 * demand, by anyone with `automationManagement:fullwrite`, to an address they
 * chose, out of an inbox nobody treats as inventory. A test is a SPECIMEN of
 * the email, not a rehearsal against live inventory, so every fact in it is
 * invented here instead.
 *
 * The values are drawn from the ranges reserved for documentation, so nothing
 * in a test email can ever collide with a real address or a real vendor:
 *   - IPv4 from 192.0.2.0/24 (RFC 5737 TEST-NET-1)
 *   - MAC from 00:00:5E:00:53:00–FF (RFC 7042 documentation range)
 * and the names are all prefixed "Example", which is the one word an operator
 * forwarding the mail to a colleague cannot mistake for a site of theirs.
 *
 * Two consequences are deliberate rather than incidental:
 *  1. **No `id`.** `{asset.link}` renders empty and `pruneDeadLinks` drops the
 *     "Open device" button — there is no device page to open, and a button
 *     that opens nothing is worse than no button.
 *  2. **No `Notification.assetId`.** A test alert is attached to no asset, so
 *     it cannot appear on a real device's alert list, and the charts are
 *     generated from sample series (`sampleChartSeries`) rather than read from
 *     somebody's telemetry.
 */

import type { AssetTemplateDetail } from "./notificationTemplate.js";

/** The device name every test alert is about. */
export const SAMPLE_ALERT_HOSTNAME = "EXAMPLE-SWITCH-01";

/**
 * The facts table of a test email, invented end to end.
 *
 * Kept in the shape `buildTemplateContext` takes so it drops straight into the
 * `assetDetail` slot a real fire fills from the database. When a new
 * `{asset.*}` token is added, add its field HERE too — otherwise the test email
 * prunes a row the real alert prints, which is the exact way a test stops being
 * a faithful specimen.
 */
export const SAMPLE_ALERT_DEVICE: AssetTemplateDetail = {
  // Deliberately absent — see the header.
  id: null,
  ipAddress: "192.0.2.51",
  macAddress: "00:00:5e:00:53:2f",
  lastSeenSwitch: "EXAMPLE-CORE-01/port12",
  // Null on purpose: a wired switch has no AP, so this row prunes away exactly
  // as it does on a real alert about the same kind of device.
  lastSeenAp: null,
  assetType: "switch",
  status: "active",
  location: "Example Site: Building A, Floor 1",
  learnedLocation: null,
  description: "Example device — the facts in this email are invented sample data.",
  manufacturer: "Example Networks",
  model: "EX-2400-24P",
  serialNumber: "EXAMPLE00000001",
  os: null,
  osVersion: null,
  department: "Example Department",
  assignedTo: null,
  tags: [],
};

/** The sensor a test of a hardware-sensor automation is "about". */
export const SAMPLE_SENSOR_NAME = "EXAMPLE-TMP1";

/** The upstream device a test of a dependency-down-alerting automation
 *  (business rule 78) blames — the switch the sample device hangs off. */
export const SAMPLE_UPSTREAM_HOSTNAME = "EXAMPLE-CORE-01";

/** The health check / WAN member pair a test of an SD-WAN automation charts. */
export const SAMPLE_SDWAN_HEALTH_CHECK = "Example-SLA";
export const SAMPLE_SDWAN_LINK = "wan1";

/** The interface a test of a port-scoped automation names. */
export const SAMPLE_INTERFACE_NAME = "port12";

/** The path check a test of a path* automation names (a made-up check,
 *  business rule 65 — never one from this install). */
export const SAMPLE_PATH_CHECK = "Example-Intranet-Check";

/**
 * The `Notification.dimension` a test alert should carry for `metric`.
 *
 * The dimension is not decoration: `alertChartService` parses it (an SD-WAN
 * alert needs a `"<healthCheck>|<link>"` pair, a sensor alert needs the bare
 * sensor name) and skips the chart outright when it can't. Inventing one per
 * metric family is what lets a test of a sensor or path automation still show
 * the chart the real alert would lead with. Null for every metric that has no
 * sub-asset dimension, which is most of them.
 */
export function sampleDimensionFor(metric: string | null | undefined): string | null {
  if (!metric) return null;
  if (metric === "hwSensorValue" || metric === "hwSensorAlarm") return SAMPLE_SENSOR_NAME;
  if (metric.startsWith("sdwan")) return `${SAMPLE_SDWAN_HEALTH_CHECK}|${SAMPLE_SDWAN_LINK}`;
  if (metric.startsWith("if") || metric === "poeStatus") return SAMPLE_INTERFACE_NAME;
  if (metric.startsWith("path")) return SAMPLE_PATH_CHECK;
  return null;
}
