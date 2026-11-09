/**
 * src/utils/rebootResultEmailTemplate.ts
 *
 * The reboot emails (business rule 115, the rule-93 shape): what happened to
 * a reboot an operator booked for later — or started now with "Email
 * notifications" ticked — sent to its recipients. Pure — takes the facts the
 * schedule service collected and renders text + HTML for ONE reader in ONE
 * zone. The sibling of firmwareResultEmailTemplate, minus the versions.
 *
 *   succeeded  — the device went down and came back (with proof).
 *   unverified — the reboot was sent but there is no proof it happened.
 *   failed     — the send was refused, or the device did not come back.
 *   refused    — a gate refused the reboot when the booking fired; nothing
 *                was sent to the device.
 *   missed     — Polaris was not running at the booked time; nothing was sent.
 *
 * And three notices before an outcome (2026-11-09): `scheduled` (booked, or
 * an address added to the booking), `rescheduled` (its time moved) and
 * `started` (the reboot was sent). `scheduled: false` is a reboot started from
 * the asset NOW with "Email notifications" ticked: "Reboot", "Started by", no
 * booked time. An automation's booking gets neither notice — only its result.
 *
 * Not an alert email: no Acknowledge button, no charts. The device link is
 * `assetPageUrl`, null when POLARIS_PUBLIC_URL is unset. The bodies are drawn
 * by `operationResultEmailLayout`, the firmware email's layout too.
 */

import { formatLocalTime, assetPageUrl } from "./notificationTemplate.js";
import {
  OPERATION_SUBJECT_VERB, bookingWarnLine, operationDuration, renderOperationEmailLayout, type OperationResultOutcome,
} from "./operationResultEmailLayout.js";

export type RebootResultOutcome = OperationResultOutcome;
type RebootEmailOutcome = RebootResultOutcome | "scheduled" | "rescheduled" | "started";

export interface RebootResultEmailInput {
  outcome: RebootEmailOutcome;
  /** A booked reboot (default) or one started now. */
  scheduled?: boolean;
  assetId: string;
  deviceName: string;
  model: string | null;
  /** How it was sent — "through FortiGate HQ (managed FortiSwitch restart)" etc. Null when nothing was sent. */
  method: string | null;
  /** What signed it. Null when nothing was sent. */
  authority: string | null;
  error: string | null;
  /** The booked time; null for a reboot started now. */
  scheduledFor: Date | string | null;
  startedAt: Date | string | null;
  finishedAt: Date | string | null;
  /** Who booked it — or, for a reboot started now, who started it. */
  scheduledBy: string;
  /** Today's blockers on a `scheduled` / `rescheduled` notice, checked again when it fires. */
  warnings?: string[];
  /** Why the reboot was booked (business rule 115(d)); omitted when nobody said. */
  note?: string | null;
  log: Array<{ t: string; level: string; msg: string }>;
  zone: string;
}

const HEADLINE: Record<RebootEmailOutcome, { label: string; color: string }> = {
  scheduled:   { label: "Reboot scheduled",   color: "#1d4ed8" },
  rescheduled: { label: "Reboot rescheduled", color: "#1d4ed8" },
  started:     { label: "Reboot started",     color: "#1d4ed8" },
  succeeded:  { label: "Reboot succeeded",   color: "#15803d" },
  unverified: { label: "Reboot unverified",  color: "#b45309" },
  failed:     { label: "Reboot failed",      color: "#b91c1c" },
  refused:    { label: "Reboot not started", color: "#b91c1c" },
  missed:     { label: "Reboot missed",      color: "#b45309" },
};

function kindLabel(input: Pick<RebootResultEmailInput, "scheduled">): string {
  return input.scheduled === false ? "Reboot" : "Scheduled reboot";
}

function rebootResultSubject(input: Pick<RebootResultEmailInput, "outcome" | "deviceName" | "scheduled" | "scheduledFor" | "zone">): string {
  if (input.outcome === "scheduled" || input.outcome === "rescheduled") {
    const when = input.scheduledFor ? ` for ${formatLocalTime(input.scheduledFor, input.zone)}` : "";
    return `[Polaris] Reboot ${input.outcome}${when}: ${input.deviceName}`;
  }
  const what = OPERATION_SUBJECT_VERB[input.outcome];
  return `[Polaris] ${kindLabel(input)} ${what}: ${input.deviceName}`;
}

function rebootResultSummary(input: RebootResultEmailInput): string {
  switch (input.outcome) {
    case "scheduled":
    case "rescheduled":
      return `The reboot is ${input.outcome === "rescheduled" ? "now " : ""}booked for ${input.scheduledFor ? formatLocalTime(input.scheduledFor, input.zone) : "later"}. ` +
        "Polaris checks the device again when it is due. You will get an email when it starts and when it finishes, or if it cannot be started.";
    case "started":
      return "Polaris has sent the reboot. The device and everything behind it will be unreachable for a few minutes. You will get another email when it is back, or if it does not come back.";
    case "succeeded":  return "The device went down and came back.";
    case "unverified": return `The reboot was sent, but Polaris could not confirm it happened${input.error ? ` (${input.error})` : ""}. Check the device.`;
    case "failed":     return `The reboot failed${input.error ? `: ${input.error}` : "."} Check the device.`;
    case "refused":    return `Polaris did not start the reboot${input.error ? `: ${input.error}` : "."} Nothing was sent to the device.`;
    case "missed":     return `${input.error ?? "Polaris was not running at the scheduled time."} Nothing was sent to the device.`;
  }
}

export function renderRebootResultEmail(input: RebootResultEmailInput): { subject: string; text: string; html: string } {
  const fmt = (d: Date | string | null) => (d ? formatLocalTime(d, input.zone) : "");
  const duration = operationDuration(input.startedAt, input.finishedAt);

  const facts: Array<[string, string]> = [["Device", input.deviceName + (input.model ? ` (${input.model})` : "")]];
  if (input.method) facts.push(["Sent", input.method]);
  if (input.authority) facts.push(["Signed by", input.authority]);
  if (input.scheduledFor) facts.push(["Scheduled for", fmt(input.scheduledFor)]);
  if (input.startedAt) facts.push(["Started", fmt(input.startedAt)]);
  if (input.finishedAt) facts.push(["Finished", fmt(input.finishedAt)]);
  if (duration) facts.push(["Duration", duration]);
  facts.push([input.scheduled === false ? "Started by" : "Scheduled by", input.scheduledBy]);
  if (input.note) facts.push(["Reason", input.note]);
  const { text, html } = renderOperationEmailLayout({
    label: kindLabel(input),
    headline: HEADLINE[input.outcome],
    summary: rebootResultSummary(input),
    warnLine: bookingWarnLine(input.outcome, input.warnings, "reboot"),
    facts,
    url: assetPageUrl(input.assetId),
    log: input.log,
    zone: input.zone,
  });
  return { subject: rebootResultSubject(input), text, html };
}
