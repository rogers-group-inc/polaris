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
 * `assetPageUrl`, null when POLARIS_PUBLIC_URL is unset.
 */

import { escapeHtml, formatLocalTime, formatElapsed, assetPageUrl } from "./notificationTemplate.js";

export type RebootResultOutcome = "succeeded" | "unverified" | "failed" | "refused" | "missed";
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

const LOG_TAIL = 15;

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
  const what = { started: "started", succeeded: "succeeded", unverified: "finished unverified", failed: "FAILED", refused: "was not started", missed: "was missed" }[input.outcome];
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
  const head = HEADLINE[input.outcome];
  const summary = rebootResultSummary(input);
  const url = assetPageUrl(input.assetId);
  const tail = input.log.slice(-LOG_TAIL);
  let duration: string | null = null;
  if (input.startedAt && input.finishedAt) {
    const ms = new Date(input.finishedAt).getTime() - new Date(input.startedAt).getTime();
    if (Number.isFinite(ms) && ms >= 0) duration = formatElapsed(ms);
  }

  const facts: Array<[string, string]> = [["Device", input.deviceName + (input.model ? ` (${input.model})` : "")]];
  if (input.method) facts.push(["Sent", input.method]);
  if (input.authority) facts.push(["Signed by", input.authority]);
  if (input.scheduledFor) facts.push(["Scheduled for", fmt(input.scheduledFor)]);
  if (input.startedAt) facts.push(["Started", fmt(input.startedAt)]);
  if (input.finishedAt) facts.push(["Finished", fmt(input.finishedAt)]);
  if (duration) facts.push(["Duration", duration]);
  facts.push([input.scheduled === false ? "Started by" : "Scheduled by", input.scheduledBy]);
  if (input.note) facts.push(["Reason", input.note]);
  const label = kindLabel(input);
  const warnings = (input.outcome === "scheduled" || input.outcome === "rescheduled") ? (input.warnings ?? []) : [];
  const warnLine = warnings.length > 0
    ? `Right now ${warnings.join("; ")}. That is checked again when the reboot is due; if it still holds then, the reboot is not started and you are told why.`
    : null;

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
  html.push("</table>", `<div style="font-size:12px;color:#6b7280;margin-top:6px">Times are shown in ${escapeHtml(input.zone)}.</div>`, "</td></tr>");
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
    "</td></tr>", "</table>", "</td></tr>", "</table>",
  );
  return { subject: rebootResultSubject(input), text: text.join("\n"), html: html.join("") };
}
