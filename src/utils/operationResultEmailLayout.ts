/**
 * src/utils/operationResultEmailLayout.ts
 *
 * The one layout behind the per-device operation emails: a firmware upgrade
 * (business rule 93, `firmwareResultEmailTemplate`) and a reboot (rule 115,
 * `rebootResultEmailTemplate`). The two say different things — their own
 * headline, summary, facts and subject — and are drawn the same way: a coloured
 * band, the kind label over the headline, the summary and an optional warning
 * line, the facts table with the device linked, "Times are shown in <zone>",
 * the tail of the run log and the "Sent by Polaris" footer. Pure.
 *
 * Shared so the two cannot drift apart. The GROUP firmware summary
 * (`firmwareGroupResultEmailTemplate`, rule 122) is a different layout — a
 * per-member table — and does not use this.
 *
 * Not an alert email: no Acknowledge button, no charts. `url` is the device
 * link (`assetPageUrl`), null when POLARIS_PUBLIC_URL is unset — the device is
 * then named without a link. `{brand.header}` is left in both bodies for
 * `applyBrandLetterhead`.
 */

import { escapeHtml, formatLocalTime, formatElapsed } from "./notificationTemplate.js";

/** How many run-log lines an operation email carries. */
export const OPERATION_LOG_TAIL = 15;

/** An outcome an operation run or booking can end in. */
export type OperationResultOutcome = "succeeded" | "unverified" | "failed" | "refused" | "missed";

/** The subject's verb for an outcome or the `started` notice. */
export const OPERATION_SUBJECT_VERB: Record<OperationResultOutcome | "started", string> = {
  started: "started",
  succeeded: "succeeded",
  unverified: "finished unverified",
  failed: "FAILED",
  refused: "was not started",
  missed: "was missed",
};

export interface OperationEmailLayoutInput {
  /** The kind label above the headline, e.g. "Scheduled reboot"; lower-cased in the footer. */
  label: string;
  headline: { label: string; color: string };
  summary: string;
  /** A warning line under the summary, or null. */
  warnLine: string | null;
  /** Label / value rows; the FIRST is the device and is linked to `url`. */
  facts: Array<[string, string]>;
  url: string | null;
  log: Array<{ t: string; level: string; msg: string }>;
  zone: string;
}

/** Finished − started, formatted; null when either is missing or the span is negative. */
export function operationDuration(startedAt: Date | string | null, finishedAt: Date | string | null): string | null {
  if (!startedAt || !finishedAt) return null;
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  return Number.isFinite(ms) && ms >= 0 ? formatElapsed(ms) : null;
}

/**
 * The warning a `scheduled` / `rescheduled` notice carries about today's
 * blockers; null for every other outcome, or when there are none. `noun` is
 * what is booked ("upgrade", "reboot").
 */
export function bookingWarnLine(outcome: string, warnings: readonly string[] | undefined, noun: string): string | null {
  const list = (outcome === "scheduled" || outcome === "rescheduled") ? (warnings ?? []) : [];
  return list.length > 0
    ? `Right now ${list.join("; ")}. That is checked again when the ${noun} is due; if it still holds then, the ${noun} is not started and you are told why.`
    : null;
}

/** Render the text and HTML bodies for ONE reader in ONE zone. */
export function renderOperationEmailLayout(input: OperationEmailLayoutInput): { text: string; html: string } {
  const { label, headline: head, summary, warnLine, facts, url } = input;
  const fmt = (d: Date | string | null) => (d ? formatLocalTime(d, input.zone) : "");
  const tail = input.log.slice(-OPERATION_LOG_TAIL);

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

  return { text: text.join("\n"), html: html.join("") };
}
