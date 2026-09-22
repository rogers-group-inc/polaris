/* public/js/push.js — Web Push enrollment helper (classic script).
 *
 * Exposes window.polarisPush: register the service worker, check status, and
 * bring a browser/PWA push subscription into line with the logged-in user's
 * NOTIFICATION PREFERENCE (business rule 39).
 *
 * There is no operator-facing enable/disable switch any more — enrollment is
 * the consequence of the account-level preference, not a decision of its own.
 * `syncToPreference` is the entry point both surfaces call at boot;
 * `enable()`/`disable()` remain as the primitives it and the preference
 * choosers are built from. `shouldOfferEnrollment` answers the one case that
 * reconcile cannot fix on its own — a browser whose permission has never been
 * asked for — by telling its caller to put the question to the operator once.
 *
 * Loaded on every desktop page that renders the sidebar (app.js wires the
 * account menu's "Notifications: …" row) and on the mobile SPA (the More tab's
 * Notification preference row). Depends on the `api` global (api.js, loaded
 * first).
 *
 * SURFACE: enable() takes { surface: "desktop" | "mobile" }. The server stores
 * it on the subscription and uses it to pick the push deep link, because on
 * Android the installed PWA and the browser share one subscription — subscribe
 * time is the only moment the surface is knowable.
 */
(function () {
  function isSupported() {
    return (
      "serviceWorker" in navigator &&
      "PushManager" in window &&
      "Notification" in window &&
      window.isSecureContext
    );
  }

  function urlBase64ToUint8Array(base64String) {
    var padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    var base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    var raw = window.atob(base64);
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  var swReg = null;
  async function registerSW() {
    if (!isSupported()) return null;
    if (swReg) return swReg;
    swReg = await navigator.serviceWorker.register("/sw.js");
    return swReg;
  }

  async function getSubscription() {
    var reg = await registerSW();
    if (!reg) return null;
    return reg.pushManager.getSubscription();
  }

  // { supported, enabledOnServer, permission, subscribed }
  async function status() {
    var supported = isSupported();
    var enabledOnServer = false;
    if (supported) {
      try {
        var key = await api.push.key();
        enabledOnServer = !!(key && key.enabled);
      } catch (e) { /* ignore */ }
    }
    var subscribed = false;
    if (supported) {
      try { subscribed = !!(await getSubscription()); } catch (e) { /* ignore */ }
    }
    return {
      supported: supported,
      enabledOnServer: enabledOnServer,
      permission: supported ? Notification.permission : "denied",
      subscribed: subscribed,
    };
  }

  function normalizeSurface(s) {
    return s === "mobile" ? "mobile" : "desktop";
  }

  async function enable(opts) {
    if (!isSupported()) throw new Error("This browser doesn't support push notifications.");

    // ─────────────────────────────────────────────────────────────────────
    // Notification.requestPermission() MUST come first, before any await
    // that hits the network.
    //
    // Safari (desktop and iOS) requires the call to happen while the click's
    // transient user activation is still live, and an awaited fetch drops it.
    // The old order (api.push.key() then requestPermission()) made the iOS
    // prompt fail silently — the single reason mobile push appeared not to
    // work at all.
    //
    // Prompting before we've confirmed the server has Web Push configured is
    // safe ONLY because every caller hides its control unless
    // status().enabledOnServer is already true (see app.js's sidebar row and
    // more-tab.js's Notifications row). Do not "tidy" this by moving the key
    // fetch back up.
    // ─────────────────────────────────────────────────────────────────────
    var perm = await Notification.requestPermission();
    if (perm !== "granted") throw new Error("Notification permission was not granted.");

    var key = await api.push.key();
    if (!key || !key.enabled || !key.publicKey) {
      throw new Error("Push isn't enabled on the server. Ask an admin to configure Web Push on Automations → Delivery.");
    }
    var reg = await registerSW();
    var sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key.publicKey),
      });
    }
    var json = sub.toJSON();
    await api.push.subscribe({
      endpoint: sub.endpoint,
      keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
      surface: normalizeSurface(opts && opts.surface),
    });
    return true;
  }

  async function disable() {
    var sub = await getSubscription();
    if (!sub) return false;
    try { await api.push.unsubscribe(sub.endpoint); } catch (e) { /* server may already be gone */ }
    await sub.unsubscribe();
    return true;
  }

  /**
   * Boot-time self-heal for rotated push endpoints.
   *
   * Browsers rotate push endpoints periodically. sw.js has a
   * pushsubscriptionchange handler for the immediate case, but that event is
   * unevenly supported (Chrome fires it; Safari's support is unreliable and it
   * may not fire at all on iOS) and it can fire with no live session. So THIS
   * is the primary mechanism, not the fallback: on every page load, re-post
   * whatever subscription the browser currently holds.
   *
   * savePushSubscription is an idempotent upsert keyed on endpoint, so a
   * repeat post costs one cheap upsert; a rotated endpoint simply lands as a
   * fresh row and the stale one is pruned by the existing 410 path.
   *
   * Silent by design — never surfaces an error to a user who did nothing.
   */
  async function reconcileSubscription(surface) {
    if (!isSupported()) return false;
    try {
      var sub = await getSubscription();
      if (!sub) return false;
      var json = sub.toJSON();
      if (!json || !json.keys || !json.keys.p256dh || !json.keys.auth) return false;
      await api.push.subscribe({
        endpoint: sub.endpoint,
        keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
        surface: normalizeSurface(surface),
      });
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Bring THIS browser's push enrollment into line with the account's stored
   * notification preference.
   *
   * This is what makes the preference a per-ACCOUNT setting instead of a
   * per-browser one: every client calls it at boot, so choosing "Push" on a
   * laptop enrolls the phone the next time it is opened, and switching back to
   * "Email" un-enrolls every device the same way.
   *
   * The one thing it will NOT do is prompt. Notification.requestPermission()
   * needs live user activation on Safari, and a boot-time call has none — so
   * an account that prefers push on a browser that has never been asked stays
   * un-enrolled until the operator picks the preference there (the menu row
   * says so). Where permission is ALREADY granted the subscribe is silent,
   * which covers every browser that has ever enrolled and every device where
   * the operator has since re-installed the app.
   *
   * Returns what it did, for the caller's own UI: "enrolled" | "removed" |
   * "needs-permission" | "" (nothing to do / not applicable). Never throws —
   * this runs on every page load for a user who did nothing.
   */
  async function syncToPreference(pref, surface) {
    if (!isSupported()) return "";
    var wantPush = pref === "push" || pref === "any";
    try {
      var sub = await getSubscription();
      if (!wantPush) {
        // "Email" is also an instruction to stop pushing to this browser.
        if (!sub) return "";
        await disable();
        return "removed";
      }
      if (sub) {
        // Already enrolled — keep the endpoint fresh (browsers rotate them).
        await reconcileSubscription(surface);
        return "";
      }
      if (Notification.permission !== "granted") return "needs-permission";
      var key = await api.push.key();
      if (!key || !key.enabled || !key.publicKey) return "";
      var reg = await registerSW();
      var fresh = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key.publicKey),
      });
      var json = fresh.toJSON();
      await api.push.subscribe({
        endpoint: fresh.endpoint,
        keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
        surface: normalizeSurface(surface),
      });
      return "enrolled";
    } catch (e) {
      return "";
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // The one-time enrollment offer (business rule 39).
  //
  // syncToPreference enrolls a browser whose permission is ALREADY granted,
  // silently, which covers every browser that has enrolled before. A browser
  // that has never been asked cannot be enrolled without raising the
  // permission prompt, and that prompt needs live user activation — so an
  // account that prefers push reaches a NEW browser only if something there
  // asks. This is that question, and the click on its Enable button is the
  // activation the prompt needs.
  //
  // It is asked ONCE per account per browser: the offer records itself the
  // moment it is shown, so dismissing it any way at all (a button, Escape, a
  // click outside, or navigating past it) is final and the account menu's
  // Notifications row is the way back. Whatever the operator answers, the
  // answer is a BROWSER fact and deliberately not an account one — the point
  // of rule 39 is that the preference belongs to the account and reaches
  // every device, so "no" on a shared kiosk must not disturb their laptop.
  // ───────────────────────────────────────────────────────────────────────
  var OFFER_ASKED_PREFIX = "polaris-push-offer-asked-";

  // Storage can be absent or throw (private mode, blocked site data). Falling
  // back to memory keeps the offer to once per PAGE LOAD there rather than
  // once per browser — the alternative is a silence nothing can lift.
  var _askedInMemory = {};

  function offerKey(username) { return OFFER_ASKED_PREFIX + (username || ""); }

  function offerAlreadyMade(username) {
    if (_askedInMemory[offerKey(username)]) return true;
    try { return window.localStorage.getItem(offerKey(username)) === "1"; }
    catch (e) { return false; }
  }

  function recordOfferMade(username) {
    _askedInMemory[offerKey(username)] = true;
    try { window.localStorage.setItem(offerKey(username), "1"); } catch (e) { /* memory it is */ }
  }

  /**
   * Should this browser be ASKED to enroll? Resolves true only when all of:
   *
   *   - push works here at all;
   *   - the ACCOUNT prefers push ("push" or "any");
   *   - permission is exactly "default" — "granted" means syncToPreference has
   *     already enrolled this browser silently, and "denied" cannot be
   *     re-prompted from script at all, so asking would open a dialog whose
   *     button provably does nothing;
   *   - this browser holds no subscription yet;
   *   - the SERVER has Web Push configured (pass `opts.status` to reuse a
   *     status() the caller has already read instead of re-fetching the key);
   *   - the offer has not already been made here.
   *
   * Never prompts and never throws — it runs on page loads for people who did
   * nothing.
   */
  async function shouldOfferEnrollment(pref, opts) {
    opts = opts || {};
    if (!isSupported()) return false;
    if (pref !== "push" && pref !== "any") return false;
    if (Notification.permission !== "default") return false;
    if (offerAlreadyMade(opts.username)) return false;
    try {
      if (await getSubscription()) return false;
      var enabledOnServer;
      if (opts.status && typeof opts.status.enabledOnServer === "boolean") {
        enabledOnServer = opts.status.enabledOnServer;
      } else {
        var key = await api.push.key();
        enabledOnServer = !!(key && key.enabled && key.publicKey);
      }
      if (!enabledOnServer) return false;
    } catch (e) {
      return false;
    }
    // Re-read rather than trust the check above: the awaits are a window in
    // which the operator may have answered the browser's prompt in another tab.
    return Notification.permission === "default";
  }

  window.polarisPush = {
    isSupported: isSupported,
    registerSW: registerSW,
    status: status,
    enable: enable,
    disable: disable,
    reconcileSubscription: reconcileSubscription,
    syncToPreference: syncToPreference,
    shouldOfferEnrollment: shouldOfferEnrollment,
    recordOfferMade: recordOfferMade,
    offerAlreadyMade: offerAlreadyMade,
  };
})();
