/* public/js/alert-ack-view.js — PolarisAlertAckView: how ONE alert is
 * presented to someone about to acknowledge it.
 *
 * Two surfaces show that presentation and must not drift apart:
 *   • /alert-ack.html (public/js/alert-ack.js) — the standalone page an emailed
 *     or pushed Acknowledge button lands on.
 *   • the in-app acknowledge modal (public/js/alert-ack-modal.js), opened from
 *     the Down Assets widget's row menu.
 *
 * The page came first and this module is its markup lifted out verbatim, so the
 * modal MIRRORS the page rather than paraphrasing it — same facts, same order,
 * same wording, same question in the note box. Presentation only: nothing here
 * fetches, decides who may acknowledge, or POSTs. That stays with each surface,
 * and the write path is `POST /alerts/acknowledge` either way (business rule 25
 * — the note policy is the server's).
 *
 * The classes are shared too (`.ack-facts`, `.ack-message`, `.ack-note-input`,
 * … in styles.css). The page keeps only its own shell rules — the card, the
 * centring wrapper, the brand row — since a modal already has those.
 */

(function () {
  "use strict";

  /* Severity → the accent colour the card's top border / the modal's rule take.
   * Mirrors the .badge-level-* palette in styles.css and utils/severityStyle.ts,
   * so this, the in-app badge and the emailed alert agree about what "serious"
   * looks like. Returned as a `var()` reference, never a literal — a hardcoded
   * hex here would survive a theme change and a token rename both. */
  var SEVERITY_VAR = {
    notice: "--color-sev-notice",
    informational: "--color-accent",
    warning: "--color-warning",
    serious: "--color-sev-serious",
    critical: "--color-danger",
  };

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function fmtTime(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    try {
      return d.toLocaleString(undefined, Object.assign({
        year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
      }, typeof timeZoneOpts === "function" ? timeZoneOpts() : {}));
    } catch (_) {
      return d.toISOString();
    }
  }

  /** The accent colour for a severity, as a CSS value. */
  function accentValue(severity) {
    var v = SEVERITY_VAR[severity];
    return v ? "var(" + v + ")" : "var(--color-border)";
  }

  /**
   * The alert's facts, in the order an operator reads them: what it is about,
   * what raised it, which sub-thing (port / sensor / mount / tunnel), how bad,
   * when — then the acknowledgement once there is one.
   *
   * The note is shown BACK. Requiring a note and then displaying it nowhere is
   * what left the in-app note write-only for a whole release (business rule 25).
   */
  function factsHtml(a) {
    var rows = [];
    if (a.assetHostname) rows.push(["Device", a.assetHostname]);
    if (a.ruleName) rows.push(["Automation", a.ruleName]);
    if (a.dimension) rows.push(["Dimension", a.dimension]);
    rows.push(["Severity", a.severity]);
    rows.push(["Raised", fmtTime(a.triggeredAt)]);
    if (a.acknowledgedBy) {
      rows.push([
        "Acknowledged by",
        a.acknowledgedBy + (a.acknowledgedAt ? " · " + fmtTime(a.acknowledgedAt) : ""),
      ]);
    }
    if (a.acknowledged && a.acknowledgeNote) rows.push(["Note", a.acknowledgeNote]);
    return '<table class="ack-facts">' + rows.map(function (r) {
      return "<tr><th>" + esc(r[0]) + "</th><td>" + esc(r[1]) + "</td></tr>";
    }).join("") + "</table>";
  }

  /** The test-run flag, the alert's own sentence, then the facts. */
  function headerHtml(a) {
    return (a.testRun ? '<span class="ack-testflag">Test alert</span>' : "")
      + '<p class="ack-message">' + esc(a.message) + "</p>"
      + factsHtml(a);
  }

  /**
   * The note field. `id` so each surface can find its own textarea; `required`
   * comes from the alert's `requireAckNote` and is a COURTESY — the refusal
   * lives in acknowledgeNotifications, which is why a 400 must re-render this
   * with the reason rather than being a dead end.
   *
   * The question is a PLACEHOLDER, never a value: it greys out, disappears on
   * the first keystroke, and an untouched box submits as no note at all. Kept
   * word-for-word in step with _ackPromptOpts in public/js/assets.js.
   */
  function noteFieldHtml(id, required) {
    return '<label class="ack-note-label" for="' + esc(id) + '">'
      + (required ? "Add a note (required)" : "Add a note (optional)") + "</label>"
      + '<textarea class="ack-note-input" id="' + esc(id) + '" maxlength="2000"'
      + ' placeholder="What is the problem and what is the fix?"'
      + (required ? " required" : "") + "></textarea>";
  }

  /** An error under the form — a refused note, a failed POST. */
  function errorHtml(text) {
    return text ? '<p class="ack-error">' + esc(text) + "</p>" : "";
  }

  /** Where "open this in Polaris" goes: the device's slide-over when the alert
   *  has one, else the Automations page. The same two destinations the alert
   *  email's own "Open device" button chooses between. */
  function appLink(a) {
    return a && a.assetId
      ? "/assets.html#view=asset:" + encodeURIComponent(a.assetId)
      : "/automations.html";
  }

  window.PolarisAlertAckView = {
    esc: esc,
    fmtTime: fmtTime,
    accentValue: accentValue,
    factsHtml: factsHtml,
    headerHtml: headerHtml,
    noteFieldHtml: noteFieldHtml,
    errorHtml: errorHtml,
    appLink: appLink,
  };
})();
