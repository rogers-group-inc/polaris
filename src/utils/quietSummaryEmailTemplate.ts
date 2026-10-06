/**
 * src/utils/quietSummaryEmailTemplate.ts
 *
 * The quiet-time SUMMARY email (business rule 92): what a quiet window kept
 * from a reader, sent to them once it ends. Pure — takes the facts the summary
 * service decided on and renders text + HTML for ONE reader in ONE zone.
 *
 * What it deliberately is not: an alert email. No charts, no Acknowledge
 * button, no facts table per alert. A reader opening this after a quiet night
 * wants a LIST — what is still broken, how long it has been, and which
 * devices kept flapping — with one link per row that opens the device in
 * Polaris. Each row's link is `assetPageUrl`, which is null when
 * POLARIS_PUBLIC_URL is unset; the row then names the device without a link,
 * the same degradation every alert email takes.
 *
 * Two sections, both optional:
 *   OUTSTANDING — alerts still active when the summary was built, oldest
 *                 first: severity, device, what, since (reader's zone), age.
 *   RECURRING   — the same alert on the same device/component fired more than
 *                 the policy's threshold during the window: device, what, the
 *                 count, every fire time, and whether it is still active. An
 *                 alert listed here is NOT repeated above.
 * With neither it is the ALL-QUIET email (`summaryAlways`, on by default):
 * nothing outstanding, how many alerts fired and recovered (or that none were
 * held), and the line that this arriving proves the quiet time and the email
 * path work — the morning heartbeat the operator asked for on 2026-10-05.
 *
 * `{brand.header}` is left in both bodies for `applyBrandLetterhead`, exactly
 * as the alert templates leave it for the drain.
 */

import { escapeHtml, formatLocalTime, formatElapsed, assetPageUrl } from "./notificationTemplate.js";

export interface SummaryOutstandingRow {
  notificationId: string;
  severity: string;
  assetId: string | null;
  assetHostname: string | null;
  ruleName: string | null;
  message: string;
  /** The component the alert is about ("port12", "/var"), or null. */
  dimension: string | null;
  triggeredAt: string; // ISO
}

export interface SummaryRecurringRow {
  assetId: string | null;
  assetHostname: string | null;
  ruleName: string | null;
  dimension: string | null;
  severity: string;
  count: number;
  /** Every fire time in the window, ISO, ascending. */
  times: string[];
  stillActive: boolean;
}

export interface QuietSummaryInput {
  sourceName: string;
  sourceKind: "automation" | "global";
  coveredFrom: Date;
  coveredTo: Date;
  /** IANA zone every timestamp is drawn in — the reader's own. */
  zone: string;
  outstanding: SummaryOutstandingRow[];
  recurring: SummaryRecurringRow[];
  recurrenceThreshold: number | null;
  /** The "all quiet" email: nothing to list. `heldCount` says how many alerts
   *  fired and recovered during the stretch (0 = none were held at all). */
  allQuiet?: boolean;
  heldCount?: number;
  now: Date;
}

export interface RenderedSummary {
  subject: string;
  text: string;
  html: string;
}

const SEVERITY_COLORS: Record<string, string> = {
  notice: "#6b7280",
  informational: "#2563eb",
  warning: "#d97706",
  serious: "#ea580c",
  critical: "#dc2626",
};

function sevColor(sev: string): string {
  return SEVERITY_COLORS[sev] ?? "#6b7280";
}

function deviceLabel(r: { assetHostname: string | null; dimension: string | null }): string {
  const host = r.assetHostname || "(no device)";
  return r.dimension ? `${host} · ${r.dimension}` : host;
}

function deviceHtml(r: { assetId: string | null; assetHostname: string | null; dimension: string | null }): string {
  const url = assetPageUrl(r.assetId);
  const host = escapeHtml(r.assetHostname || "(no device)");
  const name = url
    ? `<a href="${escapeHtml(url)}" style="color:#1d4ed8;text-decoration:none;font-weight:600">${host}</a>`
    : `<span style="font-weight:600">${host}</span>`;
  return r.dimension ? `${name} <span style="color:#6b7280">· ${escapeHtml(r.dimension)}</span>` : name;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function quietSummarySubject(input: Pick<QuietSummaryInput, "sourceName" | "outstanding" | "recurring">): string {
  const parts: string[] = [];
  if (input.outstanding.length > 0) parts.push(`${input.outstanding.length} outstanding`);
  if (input.recurring.length > 0) parts.push(`${input.recurring.length} recurring`);
  if (parts.length === 0) parts.push("all quiet");
  return `[QUIET TIME SUMMARY] ${parts.join(" · ")} · ${input.sourceName}`;
}

/** The one-liner of an all-quiet email, from how many alerts fired and recovered. */
function allQuietLine(heldCount: number): string {
  return heldCount > 0
    ? `Nothing is outstanding: ${plural(heldCount, "alert")} fired during the quiet period and ${heldCount === 1 ? "has" : "have all"} recovered.`
    : "Nothing is outstanding: no alerts were held during the quiet period.";
}

/** Render the summary for one reader. */
export function renderQuietSummaryEmail(input: QuietSummaryInput): RenderedSummary {
  const { zone, now } = input;
  const fmt = (d: Date | string) => formatLocalTime(d, zone);
  const kind = input.sourceKind === "global" ? "global quiet time" : "automation quiet time";
  const allQuiet = input.outstanding.length === 0 && input.recurring.length === 0;
  const heldCount = input.heldCount ?? 0;
  const intro = allQuiet
    ? `${kind.charAt(0).toUpperCase()}${kind.slice(1)} "${input.sourceName}" ran from ${fmt(input.coveredFrom)} to ${fmt(input.coveredTo)}. Times are shown in ${zone}.`
    : `Alerts held by ${kind} "${input.sourceName}" between ${fmt(input.coveredFrom)} and ${fmt(input.coveredTo)}. ` +
      `Times are shown in ${zone}.`;

  // ── text ──────────────────────────────────────────────────────────────────
  const text: string[] = ["{brand.header}", "", intro, ""];
  if (input.outstanding.length > 0) {
    text.push(`STILL OUTSTANDING (${input.outstanding.length})`);
    for (const r of input.outstanding) {
      const url = assetPageUrl(r.assetId);
      text.push(
        `- ${r.severity.toUpperCase()} · ${deviceLabel(r)} — ${r.message}` +
        ` · since ${fmt(r.triggeredAt)} (${formatElapsed(now.getTime() - new Date(r.triggeredAt).getTime())})` +
        (r.ruleName ? ` · ${r.ruleName}` : "") +
        (url ? `\n  ${url}` : ""),
      );
    }
    text.push("");
  }
  if (input.recurring.length > 0) {
    text.push(
      `RECURRING (${input.recurring.length})` +
      (input.recurrenceThreshold ? ` — fired more than ${plural(input.recurrenceThreshold, "time")} during the quiet period` : ""),
    );
    for (const r of input.recurring) {
      const url = assetPageUrl(r.assetId);
      text.push(
        `- ${deviceLabel(r)} — ${r.ruleName ?? r.severity}: ${plural(r.count, "time")}${r.stillActive ? ", still active" : ", recovered"}` +
        `\n  ${r.times.map((t) => fmt(t)).join("; ")}` +
        (url ? `\n  ${url}` : ""),
      );
    }
    text.push("");
  }
  if (allQuiet) {
    text.push(allQuietLine(heldCount), "", "This email also confirms that the quiet time and your email delivery are working.", "");
  }
  text.push(`Sent by Polaris · quiet time "${input.sourceName}"`);

  // ── html ──────────────────────────────────────────────────────────────────
  const cell = 'style="padding:8px 10px;border-top:1px solid #e5e7eb;font-size:13px;color:#1f2430;vertical-align:top"';
  const head = 'style="padding:6px 10px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#6b7280;text-align:left"';
  const sevPill = (sev: string) =>
    `<span style="display:inline-block;padding:2px 8px;border-radius:999px;background:${sevColor(sev)};color:#fff;font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase">${escapeHtml(sev)}</span>`;

  const html: string[] = [
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f6f8;padding:16px 0;font-family:-apple-system,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif">',
    '<tr><td align="center">',
    '<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="width:640px;max-width:100%;background:#ffffff;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden">',
    '<tr><td style="background:#4b5563;height:5px;line-height:5px;font-size:0">&nbsp;</td></tr>',
    '<tr><td style="padding:18px 22px 6px">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>',
    '<td style="vertical-align:top">',
    '<div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#4b5563;font-weight:700">Quiet time summary</div>',
    `<div style="font-size:19px;font-weight:600;color:#1f2430;margin-top:4px">${escapeHtml(input.sourceName)}</div>`,
    `<div style="font-size:13px;color:#4b5563;margin-top:6px">${escapeHtml(intro)}</div>`,
    "</td>",
    '<td style="text-align:right;vertical-align:top">{brand.header}</td>',
    "</tr></table>",
    "</td></tr>",
  ];

  if (input.outstanding.length > 0) {
    html.push(
      '<tr><td style="padding:14px 22px 4px">',
      `<div style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#374151;font-weight:700">Still outstanding (${input.outstanding.length})</div>`,
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:6px">',
      `<tr><th ${head}>Severity</th><th ${head}>Device</th><th ${head}>What</th><th ${head}>Since</th><th ${head}>Active for</th></tr>`,
    );
    for (const r of input.outstanding) {
      html.push(
        "<tr>",
        `<td ${cell}>${sevPill(r.severity)}</td>`,
        `<td ${cell}>${deviceHtml(r)}</td>`,
        `<td ${cell}>${escapeHtml(r.message)}${r.ruleName ? `<div style="color:#6b7280;font-size:12px;margin-top:2px">${escapeHtml(r.ruleName)}</div>` : ""}</td>`,
        `<td ${cell} nowrap>${escapeHtml(fmt(r.triggeredAt))}</td>`,
        `<td ${cell} nowrap>${escapeHtml(formatElapsed(now.getTime() - new Date(r.triggeredAt).getTime()))}</td>`,
        "</tr>",
      );
    }
    html.push("</table>", "</td></tr>");
  }

  if (input.recurring.length > 0) {
    html.push(
      '<tr><td style="padding:14px 22px 4px">',
      `<div style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#374151;font-weight:700">Recurring (${input.recurring.length})</div>`,
      input.recurrenceThreshold
        ? `<div style="font-size:12px;color:#6b7280;margin-top:2px">Fired more than ${escapeHtml(plural(input.recurrenceThreshold, "time"))} during the quiet period.</div>`
        : "",
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:6px">',
      `<tr><th ${head}>Device</th><th ${head}>What</th><th ${head}>Fired</th><th ${head}>When</th></tr>`,
    );
    for (const r of input.recurring) {
      html.push(
        "<tr>",
        `<td ${cell}>${deviceHtml(r)}</td>`,
        `<td ${cell}>${sevPill(r.severity)} ${escapeHtml(r.ruleName ?? "")}<div style="color:${r.stillActive ? "#b91c1c" : "#15803d"};font-size:12px;margin-top:4px;font-weight:600">${r.stillActive ? "Still active" : "Recovered"}</div></td>`,
        `<td ${cell} nowrap><strong>${r.count}</strong> ${r.count === 1 ? "time" : "times"}</td>`,
        `<td ${cell}>${r.times.map((t) => escapeHtml(fmt(t))).join("<br>")}</td>`,
        "</tr>",
      );
    }
    html.push("</table>", "</td></tr>");
  }

  if (allQuiet) {
    html.push(
      '<tr><td style="padding:14px 22px 4px">',
      `<div style="font-size:16px;color:#15803d;font-weight:700">All quiet</div>`,
      `<div style="font-size:14px;color:#1f2430;margin-top:4px">${escapeHtml(allQuietLine(heldCount))}</div>`,
      '<div style="font-size:12px;color:#6b7280;margin-top:8px">This email also confirms that the quiet time and your email delivery are working.</div>',
      "</td></tr>",
    );
  }

  html.push(
    '<tr><td style="padding:16px 22px 18px;font-size:12px;color:#6b7280;border-top:1px solid #e5e7eb;margin-top:12px">',
    `<div>Sent by Polaris · quiet time "${escapeHtml(input.sourceName)}"</div>`,
    "</td></tr>",
    "</table>",
    "</td></tr>",
    "</table>",
  );

  return {
    subject: quietSummarySubject(input),
    text: text.join("\n"),
    html: html.filter((line) => line !== "").join("\n"),
  };
}
