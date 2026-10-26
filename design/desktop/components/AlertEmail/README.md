# AlertEmail

The alert email is the third Polaris surface: a 600px table layout with a fixed light palette and every style inline, because a mail client has no theme and strips stylesheets.

The page is rendered at every sync from the template the app actually sends, `src/utils/alertEmailTemplate.ts`, composed exactly as a delivered message is (empty rows, dead links and empty chart sections pruned). To change the email, change that template; never this page.

## Anatomy

- **Severity bar** — a 5px band across the top in the severity's colour.
- **Header** — the severity word, the device name and the alert message, with the brand block (logo, app name, subtitle) on the right.
- **Facts** — a two-column table of what, where and when: rule, component, address, location, model, raised time with its time zone. A fact with no value is removed, not left blank.
- **Charts** — the last hour of the metrics the alert is about, as inline images, drawn with the same vocabulary as the app's charts (a missed poll dives red to the baseline, a dependency-down gap is grey, maintenance is a lavender band).
- **Actions** — Open in Polaris and, when the recipient can, Acknowledge.

## Rules

- Tables, not flex or grid; inline styles only; 600px wide.
- The palette is fixed hex, not theme tokens. Severity colours match the app's severity ladder.
- Plain-text alternative always ships with the HTML (`DEFAULT_ALERT_TEXT`).
