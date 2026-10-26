/**
 * Render the alert email for the Polaris UI design system's AlertEmail page,
 * from the template the app actually sends (src/utils/alertEmailTemplate.ts),
 * composed the way notificationRecipientService.buildComposedEmail composes it.
 * Charts are inline CID images in a real message; here each one is a labelled
 * placeholder, since a design page has no attachments.
 *
 * Prints JSON {critical, warning} — two rendered bodies — to stdout.
 * Run by build.mjs:  node --import tsx/esm .design-sync/render-email.ts
 */
import {
  DEFAULT_ALERT_HTML,
  pruneDeadLinks,
  pruneEmptyChartSection,
  pruneEmptyDivs,
  pruneEmptyRows,
} from "../src/utils/alertEmailTemplate.js";
import { buildTemplateContext, renderNotificationTemplate } from "../src/utils/notificationTemplate.js";
import { renderBrandBlock } from "../src/services/alertBrandService.js";
import { fillComposedAckUrl } from "../src/services/notificationRecipientService.js";

const BRAND = renderBrandBlock({ name: "Polaris", subtitle: "Network Management Tool", logo: null }, { html: true });

function chartPlaceholder(label: string): string {
  return `<div style="height:120px;background:#eef0f4;border:1px solid #e5e7eb;border-radius:4px;font-size:11px;color:#6b7280;line-height:120px;text-align:center">${label} chart (inline image in a real message)</div>`;
}

function compose(ctx: Record<string, string>, charts: Record<string, string>): string {
  let html = renderNotificationTemplate(DEFAULT_ALERT_HTML, ctx, { html: true, unknown: "blank" });
  html = html.replace(/\{brand\.header\}/g, BRAND);
  html = html.replace(/\{chart\.([A-Za-z]+)\}/g, (_, name: string) => charts[name] ?? "");
  // Neither sample has an interface, process list, dependency chain or path
  // check, and the recipients footer names real people, so those fill empty and
  // prune away, as they would in a delivered message for these alerts.
  html = html.replace(/\{(?:interface|processes|push)\.[A-Za-z.]+\}|\{(?:email\.recipients|dependency\.path|path\.graph)\}/g, "");
  html = pruneDeadLinks(pruneEmptyDivs(pruneEmptyChartSection(pruneEmptyRows(html))));
  return fillComposedAckUrl({ subject: "", text: "", html } as never, "https://polaris.example.net/alert-ack.html?t=example").html as string;
}

const time = new Date("2026-10-26T13:05:00Z");
const critical = compose(
  buildTemplateContext({
    asset: "fgt-branch-22",
    severity: "critical",
    message: "fgt-branch-22 is down — 4 consecutive missed polls",
    triggerSummary: "Monitor status is down",
    time,
    timeZone: "America/Chicago",
    ruleName: "Asset down",
    link: "https://polaris.example.net/assets.html#view=asset:a-1",
    assetDetail: { id: "a-1", ipAddress: "10.22.0.1", location: "Branch 22", manufacturer: "Fortinet", model: "FortiGate 61F" },
  } as never),
  { responseTime: chartPlaceholder("Response time"), probeLoss: chartPlaceholder("Packet loss") },
);
const warning = compose(
  buildTemplateContext({
    asset: "fgt-plant-a",
    severity: "warning",
    message: "SD-WAN member wan2 latency is 182 ms (SLA 150 ms)",
    triggerSummary: "SD-WAN latency above 150 ms",
    dimension: "Default_DNS|wan2",
    time,
    timeZone: "America/Chicago",
    ruleName: "SD-WAN latency",
    link: "https://polaris.example.net/assets.html#view=asset:a-2",
    assetDetail: { id: "a-2", ipAddress: "10.40.0.1", location: "Plant A", manufacturer: "Fortinet", model: "FortiGate 100F" },
  } as never),
  { sdwanLatency: chartPlaceholder("SD-WAN latency") },
);

process.stdout.write(JSON.stringify({ critical, warning }));
