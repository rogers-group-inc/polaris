/**
 * src/utils/firmwareResultEmailTemplate.ts
 *
 * The SCHEDULED firmware upgrade results email (business rule 93): what
 * happened to a flash an operator booked for later, sent to the booking's
 * recipients once there is an outcome. Pure — takes the facts the schedule
 * service collected and renders text + HTML for ONE reader in ONE zone.
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
 * Not an alert email: no Acknowledge button, no charts. The device link is
 * `assetPageUrl`, null when POLARIS_PUBLIC_URL is unset — the device is then
 * named without a link, the same degradation every Polaris email takes.
 * `{brand.header}` is left in both bodies for `applyBrandLetterhead`.
 */

import { escapeHtml, formatLocalTime, formatElapsed, assetPageUrl } from "./notificationTemplate.js";

export type FirmwareResultOutcome = "succeeded" | "unverified" | "failed" | "refused" | "missed";

export interface FirmwareResultEmailInput {
  outcome: FirmwareResultOutcome;
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
  scheduledFor: Date | string;
  startedAt: Date | string | null;
  finishedAt: Date | string | null;
  scheduledBy: string;
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

const HEADLINE: Record<FirmwareResultOutcome, { label: string; color: string }> = {
  succeeded:  { label: "Upgrade succeeded",  color: "#15803d" },
  unverified: { label: "Upgrade unverified", color: "#b45309" },
  failed:     { label: "Upgrade failed",     color: "#b91c1c" },
  refused:    { label: "Upgrade not started", color: "#b91c1c" },
  missed:     { label: "Upgrade missed",     color: "#b45309" },
};

export function firmwareResultSubject(input: Pick<FirmwareResultEmailInput, "outcome" | "deviceName" | "toVersion">): string {
  const what = {
    succeeded: "succeeded",
    unverified: "finished unverified",
    failed: "FAILED",
    refused: "was not started",
    missed: "was missed",
  }[input.outcome];
  return `[Polaris] Scheduled firmware upgrade ${what}: ${input.deviceName} → ${input.toVersion}`;
}

/** One sentence that says what happened, for both bodies. */
export function firmwareResultSummary(input: FirmwareResultEmailInput): string {
  switch (input.outcome) {
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
  facts.push(["Scheduled for", fmt(input.scheduledFor)]);
  if (input.startedAt) facts.push(["Started", fmt(input.startedAt)]);
  if (input.finishedAt) facts.push(["Finished", fmt(input.finishedAt)]);
  if (duration) facts.push(["Duration", duration]);
  facts.push(["Scheduled by", input.scheduledBy]);

  // ── text ──────────────────────────────────────────────────────────────────
  const text: string[] = ["{brand.header}", "", head.label.toUpperCase(), summary, ""];
  for (const [k, v] of facts) text.push(`${k}: ${v}`);
  text.push(`Times are shown in ${input.zone}.`);
  if (url) text.push("", `Open the device: ${url}`);
  if (tail.length > 0) {
    text.push("", `RUN LOG (last ${tail.length} lines)`);
    for (const l of tail) text.push(`${fmt(l.t)}  ${l.level.toUpperCase().padEnd(5)}  ${l.msg}`);
  }
  text.push("", "Sent by Polaris · scheduled firmware upgrade");

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
    '<div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#4b5563;font-weight:700">Scheduled firmware upgrade</div>',
    `<div style="font-size:19px;font-weight:600;color:${head.color};margin-top:4px">${escapeHtml(head.label)}</div>`,
    `<div style="font-size:14px;color:#1f2430;margin-top:6px">${escapeHtml(summary)}</div>`,
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
    "<div>Sent by Polaris · scheduled firmware upgrade</div>",
    "</td></tr>",
    "</table>",
    "</td></tr>",
    "</table>",
  );

  return { subject: firmwareResultSubject(input), text: text.join("\n"), html: html.join("") };
}
