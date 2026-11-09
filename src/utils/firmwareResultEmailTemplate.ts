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
 */

import { escapeHtml, formatLocalTime, formatElapsed, assetPageUrl } from "./notificationTemplate.js";

export type FirmwareResultOutcome = "succeeded" | "unverified" | "failed" | "refused" | "missed";
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

const LOG_TAIL = 15;

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
  const what = {
    started: "started",
    succeeded: "succeeded",
    unverified: "finished unverified",
    failed: "FAILED",
    refused: "was not started",
    missed: "was missed",
  }[input.outcome];
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

function durationOf(input: FirmwareResultEmailInput): string | null {
  if (!input.startedAt || !input.finishedAt) return null;
  const ms = new Date(input.finishedAt).getTime() - new Date(input.startedAt).getTime();
  return Number.isFinite(ms) && ms >= 0 ? formatElapsed(ms) : null;
}

/** Render the results email for one reader. */
export function renderFirmwareResultEmail(input: FirmwareResultEmailInput): RenderedFirmwareResult {
  const fmt = (d: Date | string | null) => (d ? formatLocalTime(d, input.zone) : "");
  const head = HEADLINE[input.outcome];
  const summary = firmwareResultSummary(input);
  const url = assetPageUrl(input.assetId);
  const duration = durationOf(input);
  const tail = input.log.slice(-LOG_TAIL);

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
  const label = kindLabel(input);
  const warnings = (input.outcome === "scheduled" || input.outcome === "rescheduled") ? (input.warnings ?? []) : [];
  const warnLine = warnings.length > 0
    ? `Right now ${warnings.join("; ")}. That is checked again when the upgrade is due; if it still holds then, the upgrade is not started and you are told why.`
    : null;

  // ── text ──────────────────────────────────────────────────────────────────
  const text: string[] = ["{brand.header}", "", head.label.toUpperCase(), summary, ""];
  if (warnLine) text.push(warnLine, "");
  for (const [k, v] of facts) text.push(`${k}: ${v}`);
  text.push(`Times are shown in ${input.zone}.`);
  if (url) text.push("", `Open the device: ${url}`);
  if (tail.length > 0) {
    text.push("", `RUN LOG (last ${tail.length} lines)`);
    for (const l of tail) text.push(`${fmt(l.t)}  ${l.level.toUpperCase().padEnd(5)}  ${l.msg}`);
  }
  text.push("", `Sent by Polaris · ${label.toLowerCase()}`);

  // ── html ──────────────────────────────────────────────────────────────────
  const factCell = 'style="padding:5px 10px 5px 0;font-size:13px;color:#6b7280;vertical-align:top;white-space:nowrap"';
  const valCell = 'style="padding:5px 0;font-size:13px;color:#1f2430;vertical-align:top"';
  const deviceHtml = url
    ? `<a href="${escapeHtml(url)}" style="color:#1d4ed8;text-decoration:none">${escapeHtml(facts[0][1])}</a>`
    : escapeHtml(facts[0][1]);

  const html: string[] = [
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f6f8;padding:16px 0;font-family:-apple-system,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif">',
    '<tr><td align="center">',
    '<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="width:640px;max-width:100%;background:#ffffff;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden">',
    `<tr><td style="background:${head.color};height:5px;line-height:5px;font-size:0">&nbsp;</td></tr>`,
    '<tr><td style="padding:18px 22px 6px">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>',
    '<td style="vertical-align:top">',
    `<div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#4b5563;font-weight:700">${escapeHtml(label)}</div>`,
    `<div style="font-size:19px;font-weight:600;color:${head.color};margin-top:4px">${escapeHtml(head.label)}</div>`,
    `<div style="font-size:14px;color:#1f2430;margin-top:6px">${escapeHtml(summary)}</div>`,
    warnLine ? `<div style="font-size:13px;color:#b45309;margin-top:6px">${escapeHtml(warnLine)}</div>` : "",
    "</td>",
    '<td style="text-align:right;vertical-align:top">{brand.header}</td>',
    "</tr></table>",
    "</td></tr>",
    '<tr><td style="padding:10px 22px 4px">',
    '<table role="presentation" cellpadding="0" cellspacing="0">',
  ];
  facts.forEach(([k, v], i) => {
    html.push(`<tr><td ${factCell}>${escapeHtml(k)}</td><td ${valCell}>${i === 0 ? deviceHtml : escapeHtml(v)}</td></tr>`);
  });
  html.push(
    "</table>",
    `<div style="font-size:12px;color:#6b7280;margin-top:6px">Times are shown in ${escapeHtml(input.zone)}.</div>`,
    "</td></tr>",
  );
  if (tail.length > 0) {
    html.push(
      '<tr><td style="padding:14px 22px 4px">',
      `<div style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#374151;font-weight:700">Run log (last ${tail.length} lines)</div>`,
      '<pre style="margin:6px 0 0;padding:10px;background:#f3f4f6;border-radius:6px;font-size:12px;line-height:1.45;color:#1f2430;white-space:pre-wrap;word-break:break-word">',
      tail.map((l) => `${escapeHtml(fmt(l.t))}  ${escapeHtml(l.level.toUpperCase())}  ${escapeHtml(l.msg)}`).join("\n"),
      "</pre>",
      "</td></tr>",
    );
  }
  html.push(
    '<tr><td style="padding:16px 22px 18px;font-size:12px;color:#6b7280;border-top:1px solid #e5e7eb">',
    `<div>Sent by Polaris · ${escapeHtml(label.toLowerCase())}</div>`,
    "</td></tr>",
    "</table>",
    "</td></tr>",
    "</table>",
  );

  return { subject: firmwareResultSubject(input), text: text.join("\n"), html: html.join("") };
}
