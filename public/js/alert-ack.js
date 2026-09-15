/* public/js/alert-ack.js — the acknowledge page an alert link lands on.
 *
 * Reached from the Acknowledge button in an alert email and from the
 * Acknowledge action on a web push. The URL names the ALERT and nothing else
 * (`/alert-ack.html?id=<notificationId>`) — there is no token in it, and no
 * credential of any kind. Identity is the reader's own Polaris session:
 * app.ts lists this page in `protectedPages`, so an unauthenticated visitor is
 * bounced to /login.html with a cookie recording where they were headed
 * (utils/loginRedirect.ts) and lands back here signed in. Business rule 25.
 *
 * Three things that follow from that, and are easy to undo by accident:
 *
 *  1. THE PAGE NEVER DECIDES WHO MAY ACKNOWLEDGE. It asks, and reports what
 *     came back. `alerts:write` is enforced by the route; a reader with only
 *     `alerts:read` reaches the page (that is the deliberate gate in
 *     pageRequiredPermission — bouncing them to "/" would leave them staring
 *     at a dashboard with no explanation of where their link went) and is told
 *     plainly that their role can't.
 *  2. THE NOTE POLICY IS THE SERVER'S. `requireAckNote` rides the alert
 *     payload and drives the label and the `required` attribute, but
 *     acknowledgeNotifications is what refuses an empty one — so a 400 from
 *     the POST re-renders the form with the reason rather than being a dead
 *     end.
 *  3. LOADING IS A GET AND ACKNOWLEDGING IS A POST. Mail gateways (Outlook
 *     Safe Links, Proofpoint) fetch every link in every message before a human
 *     sees it. Those fetches carry no session and, even if they did, this page
 *     acts only when someone presses the button.
 *
 * The alert's own presentation — the test flag, its sentence, the facts table,
 * the note field — comes from PolarisAlertAckView (public/js/alert-ack-view.js),
 * shared with the in-app acknowledge modal so the two cannot drift. What stays
 * here is this page's shell, its states, and its fetch.
 */

(function () {
  "use strict";

  var titleEl = document.getElementById("ack-title");
  var leadEl = document.getElementById("ack-lead");
  var bodyEl = document.getElementById("ack-body");
  var cardEl = document.getElementById("ack-card");
  var brandEl = document.getElementById("ack-brand");

  var appName = "Polaris";
  var alertRow = null;

  /* A session that expires while this page is open lands on the login form via
   * api.js's 401 branch — which navigates to /login.html and nothing else. The
   * server-side bounce that got the reader here set `polaris_next` for exactly
   * this reason (utils/loginRedirect.ts); re-stamping it here covers the case
   * where the session died AFTER that first page load, so signing in again
   * still returns to the alert instead of the dashboard. Path only — the
   * server re-sanitizes whatever comes back.
   *
   * The attributes mirror what the server writes, for the reason the server
   * writes them: `SameSite=Lax` is not sent on a cross-site POST, which is the
   * shape of a SAML assertion coming back from the IdP, so on HTTPS the cookie
   * goes out `None` (which a browser only accepts with `Secure`). Plain HTTP
   * has no choice but `Lax`, and the SAML login route's RelayState covers it
   * there — it reads this same cookie on its way out. */
  window.__polarisOn401 = function () {
    var secure = location.protocol === "https:";
    document.cookie = "polaris_next=" + encodeURIComponent(location.pathname + location.search)
      + "; Max-Age=600; Path=/; SameSite=" + (secure ? "None; Secure" : "Lax");
    window.location.href = "/login.html";
  };

  /* Presentation of the alert itself, shared with the in-app modal. */
  var View = window.PolarisAlertAckView;
  var esc = View.esc;

  function qs(name) {
    try {
      return new URL(window.location.href).searchParams.get(name);
    } catch (_) {
      return null;
    }
  }

  /* The card's 4px accent stripe. The colour itself is the shared module's
   * (SEVERITY_VAR there), so the page and the modal tint from one palette. */
  function accent(severity) {
    cardEl.style.setProperty("--ack-accent", View.accentValue(severity));
  }

  function appLink() { return View.appLink(alertRow); }
  function alertHeaderHtml() { return View.headerHtml(alertRow); }

  function footHtml(label) {
    return '<p class="ack-foot"><a href="' + esc(appLink()) + '">'
      + esc(label || ("Open in " + appName)) + "</a></p>";
  }

  function render(state) {
    titleEl.textContent = state.title;
    leadEl.textContent = state.lead || "";
    leadEl.style.display = state.lead ? "" : "none";
    bodyEl.innerHTML = state.html || "";
    if (typeof state.wire === "function") state.wire();
  }

  /* ─── States ────────────────────────────────────────────────────────────── */

  function showForm(errorText) {
    accent(alertRow.severity);
    var needNote = alertRow.requireAckNote === true;
    render({
      title: "Acknowledge this alert?",
      lead: needNote ? "This automation asks for a note before it can be acknowledged." : "",
      html: alertHeaderHtml()
        + View.noteFieldHtml("ack-note", needNote)
        + View.errorHtml(errorText)
        + '<div class="ack-actions">'
        + '<button type="button" class="btn btn-primary" id="ack-submit">Acknowledge</button>'
        + '<a class="btn btn-secondary" href="' + esc(appLink()) + '">Open in ' + esc(appName) + "</a>"
        + "</div>",
      wire: function () {
        var note = document.getElementById("ack-note");
        if (needNote && note) note.focus();
        document.getElementById("ack-submit").addEventListener("click", function (e) {
          submit(e.currentTarget, note ? note.value : "");
        });
      },
    });
  }

  function showAcknowledged(justNow) {
    accent(alertRow.severity);
    render({
      title: "Acknowledged",
      lead: justNow
        ? "Recorded. The alert stays visible in " + appName + " until it clears."
        : (alertRow.acknowledgedBy
            ? alertRow.acknowledgedBy + " got here first — nothing more to do."
            : "Someone already acknowledged this one."),
      html: alertHeaderHtml() + footHtml(),
    });
  }

  function showCleared() {
    accent(alertRow.severity);
    render({
      title: "This alert already cleared",
      lead: "It resolved on its own or someone cleared it, so there is nothing to acknowledge.",
      html: alertHeaderHtml() + footHtml(),
    });
  }

  function showForbidden() {
    accent(alertRow.severity);
    render({
      title: "Your account can't acknowledge alerts",
      lead: "Your " + appName + " role lets you see this alert but not acknowledge it. Ask an administrator if that is unexpected.",
      html: alertHeaderHtml() + footHtml(),
    });
  }

  function showMissing() {
    render({
      title: "This alert is not here any more",
      lead: "It may have been deleted, or it belongs to a region your account does not cover.",
      html: footHtml("Open " + appName),
    });
  }

  function showBroken(msg) {
    render({
      title: "Something went wrong",
      lead: msg || (appName + " could not load this alert just now. Try again in a moment."),
      html: '<div class="ack-actions"><button type="button" class="btn btn-secondary" id="ack-retry">Try again</button></div>',
      wire: function () {
        document.getElementById("ack-retry").addEventListener("click", function () { load(); });
      },
    });
  }

  /* ─── Acknowledge ───────────────────────────────────────────────────────── */

  async function submit(button, note) {
    button.disabled = true;
    button.textContent = "Acknowledging…";
    try {
      // `src=push` marks a reader who arrived from a web-push action button —
      // audit provenance only, and a closed set the route validates.
      var source = qs("src") === "push" ? "web_push_action" : "ack_page";
      await api.alerts.acknowledge([alertRow.id], (note || "").trim() || undefined, source);
      // Re-read rather than patching the local copy: someone else may have
      // acknowledged in between, and their name is the honest one to show.
      try {
        alertRow = await api.alerts.get(alertRow.id);
      } catch (_) {
        alertRow.acknowledged = true;
      }
      showAcknowledged(true);
    } catch (err) {
      if (err && err.status === 403) { showForbidden(); return; }
      // A 400 is the note policy refusing an empty note — form validation, not
      // a dead end, so the form comes back with the reason on it.
      showForm((err && err.message) || "Could not acknowledge that just now.");
    }
  }

  /* ─── Load ──────────────────────────────────────────────────────────────── */

  async function load() {
    var id = qs("id");
    if (!id) { showMissing(); return; }
    render({ title: "Loading alert…", lead: "" });
    try {
      alertRow = await api.alerts.get(id);
    } catch (err) {
      // 404 and 403 are the same sentence to the reader: this link does not
      // lead anywhere they can go. The route already answers 404 for an alert
      // outside their region scope rather than confirming it exists.
      if (err && (err.status === 404 || err.status === 403)) { showMissing(); return; }
      showBroken(err && err.message);
      return;
    }
    document.title = appName + " — " + (alertRow.acknowledged ? "Alert acknowledged" : "Acknowledge alert");
    if (alertRow.acknowledged) { showAcknowledged(false); return; }
    if (alertRow.cleared) { showCleared(); return; }
    showForm();
  }

  /* Branding: the same mark the login page paints, resolved by
   * PolarisBrandLogo (business rule 27 — the Application Name is text only
   * beside a CUSTOM logo, since the shipped art already spells it out). Read
   * through the unauthenticated branding endpoint login.html uses, not the
   * serverSettings wrapper, which needs a permission this reader may not hold. */
  (async function () {
    var b = null;
    try {
      var res = await fetch("/api/v1/server-settings/branding");
      if (res.ok) b = await res.json();
    } catch (_) {
      b = null;
    }
    if (b && (b.appName || "").trim()) appName = b.appName.trim();
    if (window.PolarisBrandLogo) {
      var img = document.createElement("img");
      PolarisBrandLogo.applyTo(img, b, "login");
      brandEl.appendChild(img);
      brandEl.style.display = "";
      PolarisBrandLogo.onThemeChange(function () { PolarisBrandLogo.applyTo(img, b, "login"); });
    }
    load();
  })();
})();
