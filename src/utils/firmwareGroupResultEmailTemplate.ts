/**
 * src/utils/firmwareGroupResultEmailTemplate.ts
 *
 * The GROUP firmware upgrade summary email (business rule 122): what happened
 * to every device a group booking selected, sent once to the booking's
 * recipients when the group finishes — or is missed, or is stopped after it
 * started. Pure — takes the facts the group service collected and renders text
 * + HTML for ONE reader in ONE zone.
 *
 * Layout: a headline and the counts, then the problems first (failed and
 * unverified with the stage and error; skipped for health with what was wrong;
 * skipped because a device behind it did not end clean, naming that device),
 * then the upgraded devices with from → to, then the dropped ones with why.
 * Rows within each section keep upgrade order (deepest first).
 *
 * Device links are `assetPageUrl`, null when POLARIS_PUBLIC_URL is unset —
 * the device is then named without a link. `{brand.header}` is left in both
 * bodies for `applyBrandLetterhead`.
 */

import { escapeHtml, formatLocalTime, formatElapsed, assetPageUrl } from "./notificationTemplate.js";

export type GroupOutcome = "completed" | "missed" | "cancelled";

export type GroupMemberState =
  | "planned" | "waiting" | "running" | "upgraded" | "already-current" | "failed" | "unverified" | "skipped" | "dropped";

export interface GroupEmailMember {
  assetId: string;
  deviceName: string;
  assetType: string;
  model: string | null;
  state: GroupMemberState;
  skipKind: string | null;
  detail: string | null;
  /** The run's last stage, on a failed / unverified member. */
  stage: string | null;
  fromVersion: string | null;
  toVersion: string | null;
  verifiedVersion: string | null;
}

export interface FirmwareGroupResultEmailInput {
  outcome: GroupOutcome;
  gateAssetId: string;
  gateName: string;
  scheduledFor: Date | string;
  startedAt: Date | string | null;
  finishedAt: Date | string | null;
  scheduledBy: string;
  cancelledBy: string | null;
  /** Upgrade order (deepest first). */
  members: GroupEmailMember[];
  zone: string;
}

export interface RenderedFirmwareGroupResult {
  subject: string;
  text: string;
  html: string;
}

export interface GroupCounts {
  upgraded: number;
  alreadyCurrent: number;
  failed: number;
  unverified: number;
  skippedHealth: number;
  skippedUpstream: number;
  skippedOther: number;
  dropped: number;
}

export function countGroupMembers(members: readonly Pick<GroupEmailMember, "state" | "skipKind">[]): GroupCounts {
  const c: GroupCounts = { upgraded: 0, alreadyCurrent: 0, failed: 0, unverified: 0, skippedHealth: 0, skippedUpstream: 0, skippedOther: 0, dropped: 0 };
  for (const m of members) {
    if (m.state === "upgraded") c.upgraded++;
    else if (m.state === "already-current") c.alreadyCurrent++;
    else if (m.state === "failed") c.failed++;
    else if (m.state === "unverified") c.unverified++;
    else if (m.state === "dropped") c.dropped++;
    else if (m.state === "skipped") {
      if (m.skipKind === "health") c.skippedHealth++;
      else if (m.skipKind === "subtree") c.skippedUpstream++;
      else c.skippedOther++;
    }
  }
  return c;
}

function headline(input: FirmwareGroupResultEmailInput, c: GroupCounts): { label: string; color: string } {
  if (input.outcome === "missed") return { label: "Group upgrade missed", color: "#b45309" };
  if (input.outcome === "cancelled") return { label: "Group upgrade stopped", color: "#b45309" };
  if (c.failed > 0) return { label: "Group upgrade finished with failures", color: "#b91c1c" };
  if (c.unverified + c.skippedHealth + c.skippedUpstream + c.skippedOther > 0) return { label: "Group upgrade finished with warnings", color: "#b45309" };
  return { label: "Group upgrade succeeded", color: "#15803d" };
}

export function firmwareGroupResultSubject(input: FirmwareGroupResultEmailInput): string {
  const c = countGroupMembers(input.members);
  const what = input.outcome === "missed" ? "was missed"
    : input.outcome === "cancelled" ? "was stopped"
    : c.failed > 0 ? `finished — ${c.failed} FAILED`
    : c.unverified + c.skippedHealth + c.skippedUpstream + c.skippedOther > 0 ? "finished with warnings"
    : "succeeded";
  return `[Polaris] Group firmware upgrade ${what}: ${input.gateName} (${c.upgraded} of ${input.members.filter((m) => m.state !== "dropped").length} upgraded)`;
}

function typeLabel(t: string): string {
  return t === "access_point" ? "FortiAP" : t === "switch" ? "FortiSwitch" : t === "firewall" ? "FortiGate" : t;
}

function deviceLine(m: GroupEmailMember): string {
  return `${m.deviceName} (${typeLabel(m.assetType)}${m.model ? ` ${m.model}` : ""})`;
}

function summaryLine(input: FirmwareGroupResultEmailInput, c: GroupCounts): string {
  if (input.outcome === "missed") return "Polaris was not running at the scheduled time, so the group was not started. Nothing was sent to any device.";
  const parts = [
    `${c.upgraded} upgraded`,
    c.alreadyCurrent ? `${c.alreadyCurrent} already current` : "",
    c.failed ? `${c.failed} failed` : "",
    c.unverified ? `${c.unverified} unverified` : "",
    c.skippedHealth ? `${c.skippedHealth} skipped (health)` : "",
    c.skippedUpstream ? `${c.skippedUpstream} skipped (upstream of a failure)` : "",
    c.skippedOther ? `${c.skippedOther} not started` : "",
    c.dropped ? `${c.dropped} dropped` : "",
  ].filter(Boolean);
  const lead = input.outcome === "cancelled"
    ? `The group was stopped${input.cancelledBy ? ` by ${input.cancelledBy}` : ""}; flashes already under way finished, nothing else was started.`
    : "The group upgrade finished.";
  return `${lead} ${parts.join(", ")}.`;
}

interface Section { title: string; rows: Array<{ m: GroupEmailMember; note: string }> }

/** The sections, problems first. Exported for tests. */
export function groupEmailSections(members: readonly GroupEmailMember[]): Section[] {
  const s = (title: string, pick: (m: GroupEmailMember) => string | null): Section => ({
    title,
    rows: members.flatMap((m) => { const note = pick(m); return note === null ? [] : [{ m, note }]; }),
  });
  return [
    s("Failed", (m) => m.state === "failed" ? `${m.stage ? `${m.stage}: ` : ""}${m.detail ?? "unknown error"}` : null),
    s("Unverified — check the device", (m) => m.state === "unverified" ? `${m.detail ?? "the device came back but its version could not be confirmed"}` : null),
    s("Skipped — health", (m) => m.state === "skipped" && m.skipKind === "health" ? (m.detail ?? "the device was not healthy") : null),
    s("Skipped — upstream of a device that did not finish cleanly", (m) => m.state === "skipped" && m.skipKind === "subtree" ? (m.detail ?? "a device behind it did not end clean") : null),
    s("Not started", (m) => m.state === "skipped" && m.skipKind !== "health" && m.skipKind !== "subtree" ? (m.detail ?? "not started") : null),
    s("Upgraded", (m) => m.state === "upgraded" ? `${m.fromVersion ?? "unknown"} → ${m.verifiedVersion ?? m.toVersion ?? "?"}` : null),
    s("Already current", (m) => m.state === "already-current" ? `runs ${m.verifiedVersion ?? m.toVersion ?? m.fromVersion ?? "?"}` : null),
    s("Dropped from the schedule", (m) => m.state === "dropped" ? (m.detail ?? "dropped") : null),
  ].filter((sec) => sec.rows.length > 0);
}

export function renderFirmwareGroupResultEmail(input: FirmwareGroupResultEmailInput): RenderedFirmwareGroupResult {
  const fmt = (d: Date | string | null) => (d ? formatLocalTime(d, input.zone) : "");
  const c = countGroupMembers(input.members);
  const head = headline(input, c);
  const summary = summaryLine(input, c).trim();
  const gateUrl = assetPageUrl(input.gateAssetId);
  const sections = groupEmailSections(input.members);

  const facts: Array<[string, string]> = [["FortiGate", input.gateName], ["Scheduled for", fmt(input.scheduledFor)]];
  if (input.startedAt) facts.push(["Started", fmt(input.startedAt)]);
  if (input.finishedAt) facts.push(["Finished", fmt(input.finishedAt)]);
  if (input.startedAt && input.finishedAt) {
    const ms = new Date(input.finishedAt).getTime() - new Date(input.startedAt).getTime();
    if (Number.isFinite(ms) && ms >= 0) facts.push(["Duration", formatElapsed(ms)]);
  }
  facts.push(["Scheduled by", input.scheduledBy]);

  // ── text ──────────────────────────────────────────────────────────────────
  const text: string[] = ["{brand.header}", "", head.label.toUpperCase(), summary, ""];
  for (const [k, v] of facts) text.push(`${k}: ${v}`);
  text.push(`Times are shown in ${input.zone}.`);
  if (gateUrl) text.push(`Open the FortiGate: ${gateUrl}`);
  for (const sec of sections) {
    text.push("", `${sec.title.toUpperCase()} (${sec.rows.length})`);
    for (const r of sec.rows) text.push(`  - ${deviceLine(r.m)}: ${r.note}`);
  }
  text.push("", "Sent by Polaris · group firmware upgrade");

  // ── html ──────────────────────────────────────────────────────────────────
  const factCell = 'style="padding:5px 10px 5px 0;font-size:13px;color:#6b7280;vertical-align:top;white-space:nowrap"';
  const valCell = 'style="padding:5px 0;font-size:13px;color:#1f2430;vertical-align:top"';
  const rowCell = 'style="padding:5px 10px 5px 0;font-size:13px;color:#1f2430;vertical-align:top;border-top:1px solid #f0f1f3"';
  const noteCell = 'style="padding:5px 0;font-size:13px;color:#374151;vertical-align:top;border-top:1px solid #f0f1f3"';
  const link = (id: string, label: string) => {
    const u = assetPageUrl(id);
    return u ? `<a href="${escapeHtml(u)}" style="color:#1d4ed8;text-decoration:none">${escapeHtml(label)}</a>` : escapeHtml(label);
  };

  const html: string[] = [
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f6f8;padding:16px 0;font-family:-apple-system,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif">',
    '<tr><td align="center">',
    '<table role="presentation" width="680" cellpadding="0" cellspacing="0" style="width:680px;max-width:100%;background:#ffffff;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden">',
    `<tr><td style="background:${head.color};height:5px;line-height:5px;font-size:0">&nbsp;</td></tr>`,
    '<tr><td style="padding:18px 22px 6px">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>',
    '<td style="vertical-align:top">',
    '<div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#4b5563;font-weight:700">Group firmware upgrade</div>',
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
    html.push(`<tr><td ${factCell}>${escapeHtml(k)}</td><td ${valCell}>${i === 0 ? link(input.gateAssetId, v) : escapeHtml(v)}</td></tr>`);
  });
  html.push(
    "</table>",
    `<div style="font-size:12px;color:#6b7280;margin-top:6px">Times are shown in ${escapeHtml(input.zone)}.</div>`,
    "</td></tr>",
  );
  for (const sec of sections) {
    html.push(
      '<tr><td style="padding:14px 22px 4px">',
      `<div style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#374151;font-weight:700">${escapeHtml(sec.title)} (${sec.rows.length})</div>`,
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:6px">',
    );
    for (const r of sec.rows) {
      html.push(`<tr><td ${rowCell}>${link(r.m.assetId, deviceLine(r.m))}</td><td ${noteCell}>${escapeHtml(r.note)}</td></tr>`);
    }
    html.push("</table>", "</td></tr>");
  }
  html.push(
    '<tr><td style="padding:16px 22px 18px;font-size:12px;color:#6b7280;border-top:1px solid #e5e7eb">',
    "<div>Sent by Polaris · group firmware upgrade</div>",
    "</td></tr>",
    "</table>",
    "</td></tr>",
    "</table>",
  );

  return { subject: firmwareGroupResultSubject(input), text: text.join("\n"), html: html.join("") };
}
