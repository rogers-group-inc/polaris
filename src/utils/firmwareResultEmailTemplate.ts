/**
 * src/utils/firmwareResultEmailTemplate.ts
 *
 * The firmware upgrade emails (business rule 93): what happened to a flash an
 * operator booked for later — or started now with "Email me" ticked — sent to
 * its recipients. Pure — takes the facts the schedule service / the run
 * notifier collected and renders text + HTML for ONE reader in ONE zone.
 *
 * Five outcomes, one layout:
 *   succeeded  — the device reported the new version after it came back
 *                (or was already on it).
 *   unverified — the device came back but its version could not be read.
 *   failed     — the engine or the runner failed; the error and the tail of
 *                the run log say where.
 *   refused    — a rule-87 gate refused the flash when the booking fired;
 *                nothing was sent to the device.
 *   missed     — Polaris was not running at the booked time and the booking
 *                was too late to start safely; nothing was sent.
 *
 * And three notices that come BEFORE an outcome (2026-11-09):
 *   scheduled   — the booking was made; when it runs and who booked it.
 *   rescheduled — a pending booking's time or image was changed.
 *   started     — the flash has begun (a booking firing, or a click-to-run
 *                 flash whose operator ticked "Email me").
 *
 * `scheduled: false` is a flash started from the card now (no booking): the
 * label reads "Firmware upgrade", the facts have no "Scheduled for" row and
 * the person is "Started by". Only started / succeeded / unverified / failed
 * are sent for one — refused and missed only exist for a booking.
 *
 * Not an alert email: no Acknowledge button, no charts. The device link is
 * `assetPageUrl`, null when POLARIS_PUBLIC_URL is unset — the device is then
 * named without a link, the same degradation every Polaris email takes.
 * `{brand.header}` is left in both bodies for `applyBrandLetterhead`.
 *
 * This file says WHAT the email says (headline, subject, summary, facts); the
 * bodies are drawn by `operationResultEmailLayout`, shared with the reboot
 * email so the two cannot drift apart.
 */

import { formatLocalTime, assetPageUrl } from "./notificationTemplate.js";
import {
  OPERATION_SUBJECT_VERB, bookingWarnLine, operationDuration, renderOperationEmailLayout, type OperationResultOutcome,
} from "./operationResultEmailLayout.js";

export type FirmwareResultOutcome = OperationResultOutcome;
/** A notice sent before there is an outcome. */
type FirmwareNoticeKind = "scheduled" | "rescheduled" | "started";
type FirmwareEmailOutcome = FirmwareResultOutcome | FirmwareNoticeKind;

export interface FirmwareResultEmailInput {
  outcome: FirmwareEmailOutcome;
  /** A booked flash (default) or one started from the card now. */
  scheduled?: boolean;
  assetId: string;
  deviceName: string;
  model: string | null;
  fromVersion: string | null;
  toVersion: string;
  /** What the device reported after the flash, when it said. */
  verifiedVersion: string | null;
  /** "upgraded" | "already-current" on a success. */
  result: string | null;
  error: string | null;
  /** The booked time; null for a flash started now. */
  scheduledFor: Date | string | null;
  startedAt: Date | string | null;
  finishedAt: Date | string | null;
  /** Who booked it — or, for a flash started now, who started it. */
  scheduledBy: string;
  /** Today's health blockers on a `scheduled` / `rescheduled` notice, re-checked when it fires. */
  warnings?: string[];
  /** The tail of the run log, oldest first; empty when nothing ran. */
  log: Array<{ t: string; level: string; msg: string }>;
  zone: string;
}

export interface RenderedFirmwareResult {
  subject: string;
  text: string;
  html: string;
}

const HEADLINE: Record<FirmwareEmailOutcome, { label: string; color: string }> = {
  scheduled:   { label: "Upgrade scheduled",  color: "#1d4ed8" },
  rescheduled: { label: "Upgrade rescheduled", color: "#1d4ed8" },
  started:     { label: "Upgrade started",    color: "#1d4ed8" },
  succeeded:  { label: "Upgrade succeeded",  color: "#15803d" },
  unverified: { label: "Upgrade unverified", color: "#b45309" },
  failed:     { label: "Upgrade failed",     color: "#b91c1c" },
  refused:    { label: "Upgrade not started", color: "#b91c1c" },
  missed:     { label: "Upgrade missed",     color: "#b45309" },
};

function kindLabel(input: Pick<FirmwareResultEmailInput, "scheduled">): string {
  return input.scheduled === false ? "Firmware upgrade" : "Scheduled firmware upgrade";
}

function firmwareResultSubject(input: Pick<FirmwareResultEmailInput, "outcome" | "deviceName" | "toVersion" | "scheduled" | "scheduledFor" | "zone">): string {
  if (input.outcome === "scheduled" || input.outcome === "rescheduled") {
    const when = input.scheduledFor ? ` for ${formatLocalTime(input.scheduledFor, input.zone)}` : "";
    return `[Polaris] Firmware upgrade ${input.outcome}${when}: ${input.deviceName} → ${input.toVersion}`;
  }
  const what = OPERATION_SUBJECT_VERB[input.outcome];
  return `[Polaris] ${kindLabel(input)} ${what}: ${input.deviceName} → ${input.toVersion}`;
}

/** One sentence that says what happened, for both bodies. */
function firmwareResultSummary(input: FirmwareResultEmailInput): string {
  switch (input.outcome) {
    case "scheduled":
    case "rescheduled":
      return `The upgrade to ${input.toVersion} is ${input.outcome === "rescheduled" ? "now " : ""}booked for ${input.scheduledFor ? formatLocalTime(input.scheduledFor, input.zone) : "later"}. ` +
        "Polaris checks the device again when it is due. You will get an email when it starts and when it finishes, or if it cannot be started.";
    case "started":
      return "Polaris has started the upgrade. The device reboots during it and will be unreachable for several minutes. You will get another email when it finishes.";
    case "succeeded":
      return input.result === "already-current"
        ? `The device was already running ${input.verifiedVersion ?? input.toVersion}; nothing was flashed.`
        : `The device came back and reports ${input.verifiedVersion ?? input.toVersion}.`;
    case "unverified":
      return `The device came back, but its new version could not be confirmed${input.error ? ` (${input.error})` : ""}. Check the device.`;
    case "failed":
      return `The upgrade failed${input.error ? `: ${input.error}` : "."} A flash that fails partway can leave a device unbootable — check it.`;
    case "refused":
      return `Polaris did not start the upgrade${input.error ? `: ${input.error}` : "."} Nothing was sent to the device.`;
    case "missed":
      return `${input.error ?? "Polaris was not running at the scheduled time."} Nothing was sent to the device.`;
  }
}

/** Render the results email for one reader. */
export function renderFirmwareResultEmail(input: FirmwareResultEmailInput): RenderedFirmwareResult {
  const fmt = (d: Date | string | null) => (d ? formatLocalTime(d, input.zone) : "");
  const duration = operationDuration(input.startedAt, input.finishedAt);

  const facts: Array<[string, string]> = [
    ["Device", input.deviceName + (input.model ? ` (${input.model})` : "")],
    ["Firmware", `${input.fromVersion ?? "unknown"} → ${input.toVersion}`],
  ];
  if (input.verifiedVersion) facts.push(["Device reports", input.verifiedVersion]);
  if (input.scheduledFor) facts.push(["Scheduled for", fmt(input.scheduledFor)]);
  if (input.startedAt) facts.push(["Started", fmt(input.startedAt)]);
  if (input.finishedAt) facts.push(["Finished", fmt(input.finishedAt)]);
  if (duration) facts.push(["Duration", duration]);
  facts.push([input.scheduled === false ? "Started by" : "Scheduled by", input.scheduledBy]);
  const { text, html } = renderOperationEmailLayout({
    label: kindLabel(input),
    headline: HEADLINE[input.outcome],
    summary: firmwareResultSummary(input),
    warnLine: bookingWarnLine(input.outcome, input.warnings, "upgrade"),
    facts,
    url: assetPageUrl(input.assetId),
    log: input.log,
    zone: input.zone,
  });
  return { subject: firmwareResultSubject(input), text, html };
}
