/* Polaris service worker — Web Push delivery for notifications.
 *
 * Receives pushes signed with the server VAPID key (deliverNotifications
 * web_push channel) and shows a system notification. Clicking it focuses an
 * existing Polaris tab (or opens one) at the deep link the SERVER chose.
 *
 * Registered by public/js/push.js, which loads on every desktop page that
 * renders the sidebar and on the mobile SPA.
 *
 * DEEP LINKS ARE THE SERVER'S JOB. The payload's `url` already points at the
 * right surface — /mobile.html#alerts for a subscription enrolled from
 * the mobile SPA, /automations.html for a desktop one (PushSubscription
 * .surface → pushDeepLinkUrl). This worker deliberately contains no
 * rewriting logic; it just navigates where it's told. The url may be absolute
 * or relative (relative when POLARIS_PUBLIC_URL is unset), and both
 * client.navigate() and clients.openWindow() resolve either.
 *
 * ACKNOWLEDGE BUTTON. When the payload carries `ackUrl` — the alert's
 * acknowledge page, the same URL the alert email links to — the notification
 * grows an "Acknowledge" action that OPENS it. It does not acknowledge from
 * the tray: the page is an ordinary logged-in Polaris page (business rule 25),
 * so the reader's own session is what records who acknowledged, and the page
 * is also where the note is typed. Action buttons are unsupported on
 * iOS/Safari, where the option is simply ignored and the body tap behaves as
 * it always has.
 *
 * OPEN DEVICE BUTTON. When the payload carries `assetUrl` — this alert's own
 * device page — the notification grows an "Open device" action. It is NOT the
 * same destination as the body tap: that follows the server-chosen `url`, the
 * alerts list on whichever surface enrolled this subscription, which is the
 * right landing when several alerts are firing and the wrong one when you
 * want the box this alert is about. An alert with no asset behind it (a
 * capacity warning, a failed backup, a discovery error) carries no assetUrl
 * and gets no button.
 *
 * TWO SLOTS, THREE CANDIDATES. Notification.maxActions is 2 on every browser
 * that renders actions at all, and the overflow is dropped from the END, so
 * ACTIONS is listed in priority order and sliced: Acknowledge (the only one
 * that changes state and stops escalation), then Open device, then Ignore.
 * Ignore therefore appears when a slot is free — a reader whose role can't
 * acknowledge, or an alert with no device — and otherwise yields to the two
 * that do something the toast's own close button can't.
 *
 * IGNORE BUTTON. A serious/critical alert sets `requireInteraction`, which is
 * the platform's only way to say "leave this up until it's dealt with" — there
 * is no duration member in NotificationOptions. On Windows that lands as a
 * toast with no auto-dismiss, so those alerts grow an "Ignore" action that
 * closes the notification and does nothing else. It is offered ONLY on the
 * sticky ones: a transient notification already clears itself on the OS
 * banner timer (Settings > Accessibility > Visual effects), and a button to
 * hurry that along is noise.
 *
 * Ignore is deliberately LOCAL — it sends nothing. A tray button carries no
 * session, so it cannot mean "seen" or "handled" to the server; the alert
 * stays open in Polaris and keeps escalating exactly as if the push had never
 * been read. Acknowledging is what changes state, and that happens on the
 * page (business rule 25).
 *
 * NO FETCH HANDLER, deliberately. Polaris is an online-only tool: there is no
 * offline caching, no precache, no cache versioning to keep in step with
 * deploys. Do not add one without a deliberate decision — it changes this from
 * a push worker into a caching layer that can serve stale app code.
 * (/notifications.html deep links from already-delivered pushes stay valid —
 * the server keeps that page gated + reachable forever.)
 */

var DEFAULT_URL = "/automations.html";
var NOTIFICATION_ICON = "/icons/app-192.png";
/* Severities that keep the notification on screen until it's dealt with. This
 * read `data.severity === "error"` until 2026-08 — a value the server has never
 * sent, since SEVERITIES is a closed enum of notice/informational/warning/
 * serious/critical. No alert had ever actually been sticky. */
var LOUD_SEVERITIES = ["serious", "critical"];

self.addEventListener("install", function () {
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", function (event) {
  var data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: "Polaris", body: event.data ? event.data.text() : "" };
  }
  var title = data.title || "Polaris notification";
  var options = {
    body: data.body || "",
    tag: data.notificationId || undefined,
    data: {
      // This alert's acknowledge page. The same URL for every recipient — the
      // page decides who may act, so the button below is safe to show to
      // anyone who received the push.
      url: data.url || DEFAULT_URL,
      ackUrl: data.ackUrl || null,
      assetUrl: data.assetUrl || null,
      notificationId: data.notificationId || null,
    },
    // Branded icon rendered from the operator's logo by appIconService. The
    // bare (unversioned) path is used because a service worker can't know the
    // current icon version; the route serves it with a short max-age so a
    // branding change still reaches notifications quickly.
    //
    // `badge` is deliberately omitted: Android renders it as a monochrome
    // alpha mask, so a color logo arrives as a featureless white blob — worse
    // than the platform default.
    icon: NOTIFICATION_ICON,
    requireInteraction: LOUD_SEVERITIES.indexOf(data.severity) !== -1,
  };
  // Jump straight to the acknowledge page. No feature detection: an
  // unsupported NotificationOptions member is dropped, not an error, so
  // iOS/Safari (which renders no action buttons at all) simply shows the plain
  // notification and the body tap keeps working.
  //
  // ORDER IS THE PRIORITY — see the header. The slice is explicit rather than
  // left to the platform: the drop-from-the-end behaviour is what makes this
  // order correct, and a reader of this file should not have to know that to
  // see why Ignore is last.
  var actions = [];
  if (data.ackUrl) actions.push({ action: "ack", title: "Acknowledge" });
  if (data.assetUrl) actions.push({ action: "open-asset", title: "Open device" });
  if (options.requireInteraction) actions.push({ action: "ignore", title: "Ignore" });
  var maxActions = (self.Notification && self.Notification.maxActions) || 2;
  if (actions.length) options.actions = actions.slice(0, maxActions);
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", function (event) {
  var d = event.notification.data || {};
  var url = d.url || DEFAULT_URL;
  event.notification.close();
  // Dismissal only. The close() above IS the whole action — no navigation, no
  // request, and an early return because the fallback at the bottom of this
  // handler would otherwise open the app, which is the opposite of ignoring.
  if (event.action === "ignore") return;
  // Exactly one waitUntil per invocation, taken before the first await, so the
  // worker stays alive for the whole chain.
  if (event.action === "open-asset" && d.assetUrl) {
    // Same-origin only, for the reason the ack branch is: a foreign host in a
    // payload must never become a window this worker opened. A rejected URL
    // falls back to the ordinary deep link rather than doing nothing, so the
    // tap still lands somewhere useful.
    event.waitUntil(focusOrOpen(sameOriginOr(d.assetUrl, url)));
    return;
  }
  if (event.action === "ack" && d.ackUrl) {
    // Same-origin only. The push is VAPID-signed, but resolving the URL costs
    // nothing and keeps this worker from ever navigating a window to a foreign
    // host. `src=push` is audit provenance the page forwards on acknowledge.
    var ack = sameOriginOr(d.ackUrl, null);
    if (!ack) {
      event.waitUntil(focusOrOpen(url));
      return;
    }
    var acked = new URL(ack, self.location.origin);
    acked.searchParams.set("src", "push");
    event.waitUntil(focusOrOpen(acked.href));
    return;
  }
  event.waitUntil(focusOrOpen(url));
});

/**
 * `candidate` when it resolves to THIS origin, else `fallback`.
 *
 * One helper for both action branches: the payload is VAPID-signed, so a
 * foreign URL in it would already mean the server was compromised — but
 * resolving costs nothing, and the property worth keeping is that no code
 * path in this worker can navigate a window off-origin.
 */
function sameOriginOr(candidate, fallback) {
  try {
    var u = new URL(candidate, self.location.origin);
    return u.origin === self.location.origin ? u.href : fallback;
  } catch (e) {
    return fallback;
  }
}

function focusOrOpen(url) {
  return self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (clientList) {
    for (var i = 0; i < clientList.length; i++) {
      var client = clientList[i];
      if ("focus" in client) {
        // Only navigate when the client isn't already there. The previous
        // unconditional navigate() reloaded an already-correct page,
        // throwing away scroll position and in-flight state.
        var target = new URL(url, self.location.origin).href;
        if (client.url !== target) client.navigate(target);
        return client.focus();
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  });
}

/* Endpoint rotation.
 *
 * Browsers rotate push endpoints periodically; without this the subscription
 * silently dies and the server keeps a dead endpoint until the next send
 * returns 410. Re-subscribe with the same application server key and tell the
 * server, passing the OLD endpoint so it can carry the subscription's
 * `surface` forward (a rotation mints a new endpoint, so there is no row to
 * inherit from) and retire the stale row.
 *
 * Best-effort: this can fire with no live session, and POST /push-subscriptions
 * requires alerts:read. That's why push.js ALSO re-posts the current
 * subscription on every page load (reconcileSubscription) — that boot-time
 * reconcile is the primary mechanism, since this event is unevenly supported
 * (Chrome fires it; Safari is unreliable and iOS may never fire it).
 */
self.addEventListener("pushsubscriptionchange", function (event) {
  event.waitUntil(
    (async function () {
      try {
        var oldSub = event.oldSubscription || null;
        var key = oldSub && oldSub.options && oldSub.options.applicationServerKey;

        if (!key) {
          // Not all browsers expose the old subscription's key — ask the server.
          var res = await fetch("/api/v1/push-subscriptions/key", { credentials: "include" });
          if (!res.ok) return;
          var body = await res.json();
          if (!body || !body.enabled || !body.publicKey) return;
          key = urlBase64ToUint8Array(body.publicKey);
        }

        var sub = event.newSubscription
          || (await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
        if (!sub) return;

        var json = sub.toJSON();
        if (!json || !json.keys) return;

        await fetch("/api/v1/push-subscriptions", {
          method: "POST",
          credentials: "include",
          headers: Object.assign({ "Content-Type": "application/json" }, await csrfHeader()),
          body: JSON.stringify({
            endpoint: sub.endpoint,
            keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
            oldEndpoint: oldSub ? oldSub.endpoint : undefined,
          }),
        });
      } catch (e) {
        // Nothing useful to do here — the boot-time reconcile in push.js
        // repairs this on the user's next visit.
      }
    })()
  );
});

/* A service worker has no document.cookie, so read the (non-HttpOnly) CSRF
 * cookie via the Cookie Store API. Chrome supports it — and Chrome is also the
 * browser that actually fires pushsubscriptionchange, so this covers the real
 * case. Where it's unavailable we send no header and the POST is rejected by
 * the CSRF middleware; that's an accepted loss, because push.js's boot-time
 * reconcile repairs the subscription on the user's next visit. */
async function csrfHeader() {
  try {
    if (self.cookieStore && self.cookieStore.get) {
      var c = await self.cookieStore.get("polaris_csrf");
      if (c && c.value) return { "X-CSRF-Token": c.value };
    }
  } catch (e) { /* ignore */ }
  return {};
}

function urlBase64ToUint8Array(base64String) {
  var padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  var base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  var raw = self.atob(base64);
  var out = new Uint8Array(raw.length);
  for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
