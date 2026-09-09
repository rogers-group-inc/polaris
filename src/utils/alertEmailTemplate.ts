/**
 * src/utils/alertEmailTemplate.ts — the default alert email, as a TEMPLATE.
 *
 * The old default was two lines: the message, and a "View:" link to
 * /automations.html — a page that lists automations rather than the device
 * that is hurting. This is the replacement, and it is deliberately expressed
 * in the same `{token}` vocabulary an operator types into a Notify action's
 * "Customize the email" fields rather than as server-side string building.
 *
 * That matters for one reason: what Polaris sends and what the operator can
 * edit are the same text. The automation wizard prefills a new Notify action
 * with exactly these strings (schema.defaultEmailTemplate), so the email in
 * the inbox is always the template on the screen — edit it, reorder it, drop
 * the charts, and the result is what ships. A stored automation that carries
 * no composition still renders through here, so existing rules get the new
 * body without a migration.
 *
 * HTML rules, learned the hard way by everyone who has done this:
 *   - tables, not flexbox or grid (Outlook renders through Word)
 *   - inline styles only; no <style> block, no classes
 *   - no remote images — the charts ride as inline CID attachments
 *   - a real plain-text alternative, since some clients show only that
 *
 * Rows whose token renders empty are dropped by `pruneEmptyRows` before send,
 * so an asset with no AP, no serial and no CPU history doesn't email a column
 * of blank cells.
 */

export const DEFAULT_ALERT_SUBJECT = "[{severity.upper}] {asset} — {rule}";

/**
 * Plain-text alternative. Not a stripped copy of the HTML: it is the version
 * a pager gateway or a text-only client shows, so the links are spelled out
 * rather than hidden behind anchors.
 */
export const DEFAULT_ALERT_TEXT = [
  // The letterhead's text form: "Polaris — Network Management Tool". No image
  // here, so this is the only thing naming the sender, which is why it prints
  // the app name even in the shipped-branding case where the HTML leaves that
  // to the wordmark art. Renders away (and its blank line collapses) on an
  // install that blanked both fields.
  "{brand.header}",
  "",
  "{severity.upper}: {trigger.summary}",
  "",
  // The reminder that ends a quiet period leads with the fact that it does,
  // and with the alert's age (business rule 44). Above the facts because
  // after a silent night "how long has this been going on" is the question,
  // and it renders away — collapsing its blank line with it — on every other
  // send, including every ordinary reminder.
  "{repeat.quiet}",
  // No {message} line here either — same redundancy, and the two bodies must
  // stay in step or an operator editing one wonders why the other differs.
  // "Subject", not "Device": plenty of alerts are about Polaris itself (a
  // capacity escalation, a failed backup, the host's own CPU) rather than
  // about a monitored device, and labelling the Polaris server as a "Device"
  // is what made those emails read like they were about somebody's switch.
  "Subject:    {asset}",
  "IP:         {asset.ip}",
  "Switch:     {asset.connectedSwitch}",
  "AP:         {asset.connectedAp}",
  "Location:   {asset.location}",
  "Description: {asset.description}",
  "Event:      {event.action}",
  "Resource:   {event.resource}",
  "Triggered by: {event.actor}",
  "Detail:     {event.message}",
  "Severity:   {severity}",
  // What happens if they do nothing. Both prune away (pruneEmptyTextLines)
  // on an automation that neither repeats nor escalates, so a one-shot alert
  // is unchanged.
  "Reminders:  {repeat.policy}",
  "Escalation: {escalation.policy}",
  // {time.local} rather than {time}: the ISO-8601 form is what a machine wants,
  // and "2026-08-12T18:46:01.561Z" is also a 24-character unbreakable string
  // that wrapped mid-token in the HTML table. {time} stays catalogued for
  // operator templates that want the machine form.
  "Raised:     {time.local}",
  // How long it has been going on. Blank (and pruned) on the initial alert —
  // "Active for: 0m" beside "Raised: just now" is noise — and filled on every
  // reminder, which is the send where the reader's own clock is no longer the
  // answer.
  "Active for: {repeat.elapsed}",
  "",
  // What was on the port, when the alert is about ONE port. Renders away for
  // every other alert — and for a port that advertised no neighbour — so it
  // costs a non-interface alert nothing. Above the charts because on an
  // interface alert the charts render away entirely (alertInterfaceService).
  "{interface.lldp}",
  "",
  "{chart.trigger}",
  "{chart.sensor}",
  "{chart.probeLoss}",
  // The SD-WAN trio, above the device charts because on a path alert those are
  // dropped (alertChartService's SDWAN_SCOPED_METRICS) and these three ARE the
  // email: latency, jitter and loss on the health check and WAN member that
  // fired. All three ride together — an operator whose automation watches
  // latency still needs to see whether loss moved with it — and all three
  // render away on every alert that isn't about SD-WAN.
  "{chart.sdwanLatency}",
  "{chart.sdwanJitter}",
  "{chart.sdwanLoss}",
  "{chart.cpu}",
  "{chart.memory}",
  "{chart.responseTime}",
  "",
  "Open device:      {asset.link}",
  "Acknowledge:      {ack}",
].join("\n");

/**
 * One label/value row of the facts table.
 *
 * The label column is a FIXED width rather than shrink-to-fit. With auto
 * layout the two columns are sized from their content, so a body whose facts
 * are down to "Automation" and "Raised" — every alert about Polaris itself,
 * where the device rows prune away — gave the labels most of the 600px and
 * wrapped the values into a two-word-wide gutter. A fixed label column means
 * the value always gets the rest of the card, and `word-break` keeps a long
 * unbroken value (a URL, an ISO timestamp) inside it instead of widening the
 * table past the card. `vertical-align:top` keeps a wrapped value's first line
 * level with its label.
 */
export const factRow = (label: string, value: string): string =>
  `<tr><td width="140" style="width:140px;padding:3px 12px 3px 0;color:#6b7280;vertical-align:top;white-space:nowrap">${label}</td>` +
  `<td style="padding:3px 0;vertical-align:top;word-break:break-word">${value}</td></tr>`;

/**
 * HTML body. The two buttons are bulletproof-ish table buttons rather than
 * styled anchors so Outlook renders them as buttons and not as underlined
 * text; both degrade to plain links everywhere else.
 */
export const DEFAULT_ALERT_HTML = [
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f6f8;padding:16px 0;font-family:-apple-system,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif">',
  '<tr><td align="center">',
  '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;background:#ffffff;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden">',
  // Severity bar + headline
  '<tr><td style="background:{severity.color};height:5px;line-height:5px;font-size:0">&nbsp;</td></tr>',
  '<tr><td style="padding:18px 22px 6px">',
  // Two columns: the alert on the left, the install's letterhead on the right.
  // A table rather than two floated divs — Outlook renders through Word, which
  // has no float. (What keeps `pruneEmptyRows` off the two-cell row this opens
  // is the one-cell table INSIDE the letterhead cell; see the note there.)
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>',
  '<td style="vertical-align:top">',
  '<div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:{severity.color};font-weight:700">{severity} alert</div>',
  '<div style="font-size:19px;font-weight:600;color:#1f2430;margin-top:4px">{asset}</div>',
  // What fired, in the builder's own words, with the reading in it. This leads
  // because "Response time (median over 5 minutes) is 760 ms" is the sentence
  // the operator wrote the automation in — the raw message underneath it reads
  // like a log line.
  '<div style="font-size:16px;font-weight:600;color:{severity.color};margin-top:8px">{trigger.summary}</div>',
  // The quiet-period notice (business rule 44). A DIV, not a facts row, for
  // two reasons: it belongs above the facts on the one send it appears on, and
  // `pruneEmptyDivs` deletes an exactly-empty div — so on every other send it
  // and its whole band of padding disappear rather than leaving a grey stripe.
  // No token but this one inside it, or the div is never exactly empty.
  '<div style="font-size:13px;font-weight:600;color:#374151;background:#f3f4f6;border-left:3px solid {severity.color};padding:8px 10px;margin-top:10px">{repeat.quiet}</div>',
  // {message} is deliberately NOT printed under it. The two say the same thing:
  // the sentence above is generated from the automation's own trigger, and the
  // message — whether the generated default or a template like "{asset} is
  // down" — restates it, so a "Monitor status is down" headline was followed by
  // a grey "HARBOR-61F-1 is down". The message keeps its real homes (the in-app
  // alert card, and every chat / push body, which have no trigger sentence),
  // and {message} stays catalogued for an operator who wants it back.
  "</td>",
  // The letterhead — logo, application name, subtitle — right-aligned opposite
  // the headline. `{brand.header}` is DEFERRED (alertBrandService, at delivery
  // like the charts) because the logo rides as an inline CID attachment, and it
  // expands to the cell's whole contents or to nothing at all, so an install
  // with no mark and no subtitle leaves an empty cell rather than a gap where
  // text used to be. The fixed width keeps the headline's column from
  // collapsing when a wide logo is in play.
  //
  // The inner one-cell table is not decoration: it is what makes this row
  // IMMUNE to `pruneEmptyRows`. The header is a two-cell row whose second cell
  // is empty on an install with no letterhead — precisely the label/value shape
  // that pass deletes, and deleting it would take the severity line, the
  // subject and the trigger sentence with it. A row containing a `<table>`
  // fails that pattern outright, and a one-cell row is never a candidate. It
  // also right-aligns in Outlook, which honours `align` on a table where it
  // ignores an auto margin.
  // 168 = alertBrandService's MAX_LOGO_WIDTH (150) + this cell's 14px gutter,
  // rounded up: a declared width narrower than the image it holds is a width
  // the mail client silently overrides, widening the cell into the headline.
  // The two numbers have to move together.
  '<td width="168" style="width:168px;padding-left:14px;vertical-align:top;text-align:right">',
  '<table role="presentation" cellpadding="0" cellspacing="0" align="right"><tr>',
  '<td style="text-align:right">{brand.header}</td>',
  "</tr></table>",
  "</td>",
  "</tr></table>",
  "</td></tr>",
  // Facts
  '<tr><td style="padding:10px 22px 0">',
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;color:#374151;border-collapse:collapse">',
  factRow("IP address", "{asset.ip}"),
  factRow("Connected switch", "{asset.connectedSwitch}"),
  factRow("Connected AP", "{asset.connectedAp}"),
  factRow("Location", "{asset.location}"),
  factRow("Model", "{asset.manufacturer} {asset.model}"),
  // Last of the asset rows, and deliberately so: it's the only free-text one,
  // so a paragraph-long description can't push IP / switch / location out of
  // the reader's first glance. Prunes away like the rest when unset.
  factRow("Description", "{asset.description}"),
  // Event-path rows. An event automation usually fires on something that is
  // NOT a device (an integration, a user, the host), so the asset rows above
  // prune away and these are the only facts the reader gets. They prune away
  // in turn on a metric alert, which has no event behind it.
  factRow("Event", "{event.action}"),
  factRow("{event.resourceType}", "{event.resource}"),
  factRow("Triggered by", "{event.actor}"),
  // The event's own text — the REASON. "integration.discover.error" names what
  // broke and this says why ("Discovery failed: RPC -11 no valid session"). It
  // rides its own row rather than {message} so it survives whatever the rule's
  // message template says; last of the event rows because it's the long one.
  factRow("Detail", "{event.message}"),
  factRow("Automation", "{rule}"),
  factRow("Raised", "{time.local}"),
  // How long it has been going on — beside the time it was raised, since the
  // two are read together. Empty (and pruned by pruneEmptyRows) on the initial
  // alert, filled on every reminder. Mirrors the text body's "Active for"
  // line; the two must stay in step.
  factRow("Active for", "{repeat.elapsed}"),
  // What happens if the reader does nothing. Last in the facts table, under
  // the automation that decided it — these describe the AUTOMATION's
  // behaviour, not the device's, so they belong beside {rule} rather than up
  // among the device facts. Both prune away (pruneEmptyRows) on an alert that
  // neither repeats nor escalates, which is most of them.
  factRow("Reminders", "{repeat.policy}"),
  factRow("Escalation", "{escalation.policy}"),
  "</table>",
  "</td></tr>",
  // The LLDP neighbours on the interface this alert is about — a complete <tr>
  // with its own heading, or nothing at all. It is filled at DELIVERY time
  // (alertInterfaceService, like the charts) and is the substance of an
  // "interface down" email: the device is answering, so its own graphs explain
  // nothing, and "what was plugged into port2" is the question being asked.
  "{interface.lldp}",
  // Charts — the last hour of the metrics that explain most alerts. The sensor
  // chart leads because when it renders at all, it IS what the alert is about:
  // a hardware-sensor automation (value or alarm) charts the sensor it fired
  // on. It renders away entirely for every other kind of alert.
  // data-section="charts" is what pruneEmptyChartSection looks for at delivery
  // time: every chart token can render away (an alert about Polaris itself has
  // no asset to chart at all), and a "LAST HOUR" heading over nothing reads as
  // a broken email rather than as "no telemetry applies here".
  '<tr data-section="charts"><td style="padding:14px 22px 0">',
  '<div style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#6b7280;font-weight:700;margin-bottom:2px">Last hour</div>',
  "{chart.trigger}",
  "{chart.sensor}",
  "{chart.probeLoss}",
  // See the text body: on an SD-WAN alert these three replace the device
  // charts below rather than joining them.
  "{chart.sdwanLatency}",
  "{chart.sdwanJitter}",
  "{chart.sdwanLoss}",
  "{chart.cpu}",
  "{chart.memory}",
  "{chart.responseTime}",
  "</td></tr>",
  // Actions
  '<tr><td style="padding:16px 22px 22px">',
  '<table role="presentation" cellpadding="0" cellspacing="0"><tr>',
  '<td style="border-radius:6px;background:{severity.color}"><a href="{ack}" style="display:inline-block;padding:11px 18px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none">Acknowledge alert</a></td>',
  '<td style="width:10px">&nbsp;</td>',
  '<td style="border-radius:6px;border:1px solid #d1d5db"><a href="{asset.link}" style="display:inline-block;padding:10px 17px;font-size:14px;font-weight:600;color:#374151;text-decoration:none">Open device</a></td>',
  "</tr></table>",
  "</td></tr>",
  "</table>",
  '<div style="font-size:11px;color:#9ca3af;margin-top:10px">Sent by Polaris · automation "{rule}"</div>',
  "</td></tr></table>",
].join("\n");

export interface AlertEmailTemplate {
  subjectTemplate: string;
  bodyTextTemplate: string;
  bodyHtmlTemplate: string;
}

export function defaultAlertEmailTemplate(): AlertEmailTemplate {
  return {
    subjectTemplate: DEFAULT_ALERT_SUBJECT,
    bodyTextTemplate: DEFAULT_ALERT_TEXT,
    bodyHtmlTemplate: DEFAULT_ALERT_HTML,
  };
}

/**
 * Drop rows / lines whose value came out empty.
 *
 * Every `{asset.*}` token renders "" when the field is unset, so a workstation
 * with no AP, no model and no location would otherwise mail a facts table of
 * blank cells — which reads as broken rather than as "not applicable".
 *
 * HTML: a `<tr>` whose SECOND cell has no text content is removed. Text: a
 * "Label: <nothing>" line is removed. Both operate on the RENDERED body, so
 * an operator's own rows get the same treatment as ours.
 */
export function pruneEmptyRows(html: string): string {
  // The match may NOT span a nested `<table>` or a second `<tr>`. Without those
  // two exclusions the pattern started at a layout row — `<tr><td>` wrapping the
  // facts table — and ran to the first `</tr>` inside it, which belongs to the
  // first FACT row. That span looks exactly like a two-cell label/value pair
  // (the container's own <td>, then the fact row's empty value cell), so
  // dropping it took the facts table's opening `<table>` tag with it: the
  // surviving rows reparented onto the 600px card and the now-unmatched
  // `</table>` closed the card early, putting "Last hour" and the buttons
  // OUTSIDE the box. It fired whenever the first fact row was empty — i.e. on
  // every alert about Polaris itself, which has no {asset.ip}.
  //
  // Failing the match at the container (rather than matching and skipping it)
  // is what lets the engine advance INTO the table and judge each fact row on
  // its own; a guard that returned the container unchanged consumed the first
  // fact row with it and left an empty "IP address" cell behind.
  return html.replace(/<tr\b[^>]*>(?:(?!<\/tr>|<tr\b|<table\b).)*<\/tr>/gs, (row) => {
    const cells = Array.from(row.matchAll(/<td[^>]*>(.*?)<\/td>/gs), (m) => m[1] ?? "");
    // Only touch two-cell label/value rows — never the layout scaffolding,
    // the severity bar, or the button row.
    if (cells.length !== 2) return row;
    const value = cells[1]!.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim();
    return value.length === 0 ? "" : row;
  });
}

/**
 * Drop a button whose link came out empty.
 *
 * {ack} is blank for a recipient Polaris knows may not acknowledge — a
 * read-only account, and on an install with no POLARIS_PUBLIC_URL everyone —
 * and {asset.link} is blank without that public URL too.
 * Left alone, those render as `<a href="">` — a button that reloads whatever
 * page the reader is on, which is worse than no button. The spacer cell
 * between the two buttons goes with them when it ends up on an edge.
 */
export function pruneDeadLinks(html: string): string {
  return html
    .replace(/<td[^>]*>\s*<a\s+href=""[^>]*>.*?<\/a>\s*<\/td>/gs, "")
    // A spacer left at the start or end of its row after the drop.
    .replace(/(<tr>)\s*<td style="width:10px">&nbsp;<\/td>/g, "$1")
    .replace(/<td style="width:10px">&nbsp;<\/td>\s*(<\/tr>)/g, "$1")
    // An operator's own template needn't wrap its button in a cell. A bare
    // anchor with an empty href is dead wherever it sits, and since a
    // recipient who may not acknowledge is now mailed the blanked body on
    // purpose (business rule 25), leaving one behind means a live-looking
    // "Acknowledge" that does nothing.
    .replace(/<a\s+href=""[^>]*>.*?<\/a>/gs, "");
}

/**
 * Drop a header line whose token rendered empty.
 *
 * The header's three lines are divs, not table rows, so `pruneEmptyRows` never
 * saw them: an alert with no subject line ({asset} empty) or no trigger
 * sentence (a context snapshotted before that token existed) mailed an empty
 * div and the vertical space that goes with it. Only exactly-empty divs match,
 * so nothing with content — or with a chart token still waiting for its
 * delivery-time fill — is touched.
 */
export function pruneEmptyDivs(html: string): string {
  return html.replace(/<div\b[^>]*>\s*<\/div>\n?/g, "");
}

/**
 * Drop the charts section when nothing rendered into it.
 *
 * Runs at DELIVERY time, after `substituteChartTokens` — that is the pass that
 * decides a chart has no data and removes its token, and it is also the point
 * where an alert with no asset at all (Polaris's own capacity, a failed backup)
 * ends up with every token gone. What's left is the "Last hour" heading over
 * empty space. A row is kept if it gained an <img> (a chart) or a <p> (the
 * numbers-only fallback when the rasterizer failed).
 */
export function pruneEmptyChartSection(html: string): string {
  return html.replace(/<tr\b[^>]*data-section="charts"[^>]*>(?:(?!<\/tr>).)*<\/tr>\n?/gs, (row) =>
    /<img\b|<p\b/i.test(row) ? row : "",
  );
}

/** Text-body counterpart: drop "Label:" lines with nothing after the colon. */
export function pruneEmptyTextLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => {
      const m = /^([A-Za-z][\w .]*):\s*(.*)$/.exec(line);
      if (!m) return true;
      return m[2]!.trim().length > 0;
    })
    .join("\n")
    // Collapse the runs of blank lines the drops leave behind.
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
