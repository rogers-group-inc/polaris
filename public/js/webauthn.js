/**
 * public/js/webauthn.js — the browser half of a WebAuthn ceremony.
 *
 * Pure plumbing: base64url ↔ ArrayBuffer, and the two `navigator.credentials`
 * calls wrapped so they take and return the JSON shapes the server speaks
 * (@simplewebauthn/server's `…OptionsJSON` in, `…ResponseJSON` out). No fetch,
 * no DOM, no dependency on api.js — login.html deliberately does not load the
 * API client, and the account-menu modal on every other page does, so the one
 * thing they share has to stand alone.
 *
 * Hand-rolled rather than pulling in @simplewebauthn/browser: it is ~60 lines
 * of base64url, the repo has no build step (a bundled vendor copy would be a
 * fourth thing under public/js/vendor to keep current), and the conversions
 * below are exactly the ones the spec names.
 *
 * NOT USED HERE: conditional mediation ("passkey autofill", where focusing the
 * username field silently offers credentials). It is the nicer UX, but it fires
 * a challenge request on every load of the login page — and a whole office
 * behind one NAT address would burn the ceremony rate limit just by looking at
 * the page. An explicit button costs one click and spends nothing until the
 * user means it.
 */

(function () {
  "use strict";

  function bufferToBase64url(buffer) {
    var bytes = new Uint8Array(buffer);
    var str = "";
    for (var i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
    return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function base64urlToBuffer(value) {
    var padded = String(value).replace(/-/g, "+").replace(/_/g, "/");
    while (padded.length % 4) padded += "=";
    var binary = atob(padded);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  /**
   * Can this browser, on this page, run a ceremony at all?
   *
   * `isSecureContext` is the check that matters in practice: Polaris supports
   * plain-HTTP installs, and on one of those the credentials API exists but
   * every call rejects. Asking first is what lets the caller say "your install
   * isn't on HTTPS" instead of surfacing a raw SecurityError.
   */
  function supported() {
    return typeof window.PublicKeyCredential === "function" &&
      !!(navigator.credentials && navigator.credentials.create) &&
      window.isSecureContext === true;
  }

  /**
   * Why THIS page cannot run a ceremony the SERVER believes is available, or
   * null when it can.
   *
   * The server decides availability from the request it received; the browser
   * decides it from the page it is on, and behind a reverse proxy those two can
   * disagree. The disagreement worth naming is a rewritten Host: Polaris derives
   * the RP ID from the Host header that reached it, so a proxy passing its own
   * upstream name through produces an rpId that is not a registrable suffix of
   * the page's origin — and the browser answers that with a bare SecurityError
   * ("This page's address does not match…") that names no cause. Comparing the
   * two here turns it into the proxy header it actually is.
   *
   * @param rpId the server's derived RP ID (availability.rpId), or falsy
   */
  function unavailableHere(rpId) {
    if (typeof window.PublicKeyCredential !== "function" || !(navigator.credentials && navigator.credentials.create)) {
      return "This browser does not support passkeys.";
    }
    if (window.isSecureContext !== true) {
      return "This page is not a secure context, so the browser will not run a passkey ceremony. Reach Polaris over HTTPS, or from localhost.";
    }
    var host = String(window.location.hostname || "").toLowerCase();
    var rp = String(rpId || "").toLowerCase();
    if (rp && host !== rp && !host.endsWith("." + rp)) {
      return 'Polaris read the passkey domain "' + rp + '" off the Host header of this request, but the page is on "' + host +
        '" — a reverse proxy in front of Polaris is replacing the Host header, and the browser refuses a passkey scoped to a domain ' +
        "that is not its own. Have the proxy forward the original host (nginx: proxy_set_header Host $host), or set the passkey " +
        "domain explicitly under Authentication → Settings.";
    }
    return null;
  }

  /** True when this device has a built-in authenticator (Touch ID, Windows Hello). */
  async function platformAuthenticatorAvailable() {
    if (!supported()) return false;
    try {
      return await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    } catch (_) {
      return false;
    }
  }

  function toCreationOptions(json) {
    var options = Object.assign({}, json);
    options.challenge = base64urlToBuffer(json.challenge);
    options.user = Object.assign({}, json.user, { id: base64urlToBuffer(json.user.id) });
    options.excludeCredentials = (json.excludeCredentials || []).map(function (c) {
      return Object.assign({}, c, { id: base64urlToBuffer(c.id) });
    });
    return options;
  }

  function toRequestOptions(json) {
    var options = Object.assign({}, json);
    options.challenge = base64urlToBuffer(json.challenge);
    if (json.allowCredentials) {
      options.allowCredentials = json.allowCredentials.map(function (c) {
        return Object.assign({}, c, { id: base64urlToBuffer(c.id) });
      });
    }
    return options;
  }

  /**
   * Turn a browser exception into something worth showing a person.
   *
   * NotAllowedError is the one that matters: it is what the browser throws for
   * BOTH "the user closed the dialog" and "the credential didn't match", on
   * purpose, so the page must not claim to know which. Everything else names
   * itself usefully enough to pass through.
   */
  function describeError(err) {
    if (!err) return "Passkey sign-in failed.";
    if (err.name === "NotAllowedError") return "Passkey prompt cancelled or timed out.";
    if (err.name === "InvalidStateError") return "That passkey is already registered on this account.";
    if (err.name === "SecurityError") {
      return "This page's address does not match the domain the passkey is registered to.";
    }
    if (err.name === "AbortError") return "Passkey prompt cancelled.";
    return err.message || "Passkey sign-in failed.";
  }

  /** Run a registration ceremony. Returns a RegistrationResponseJSON. */
  async function create(optionsJSON) {
    var credential = await navigator.credentials.create({ publicKey: toCreationOptions(optionsJSON) });
    if (!credential) throw new Error("No credential was created.");
    var response = credential.response;
    return {
      id: credential.id,
      rawId: bufferToBase64url(credential.rawId),
      type: credential.type,
      authenticatorAttachment: credential.authenticatorAttachment || undefined,
      clientExtensionResults: credential.getClientExtensionResults
        ? credential.getClientExtensionResults()
        : {},
      response: {
        clientDataJSON: bufferToBase64url(response.clientDataJSON),
        attestationObject: bufferToBase64url(response.attestationObject),
        // Older authenticators omit getTransports entirely; an absent list is
        // valid and simply means the browser will not get a prompt hint later.
        transports: typeof response.getTransports === "function" ? response.getTransports() : [],
      },
    };
  }

  /** Run an authentication ceremony. Returns an AuthenticationResponseJSON. */
  async function get(optionsJSON) {
    var credential = await navigator.credentials.get({ publicKey: toRequestOptions(optionsJSON) });
    if (!credential) throw new Error("No credential was returned.");
    var response = credential.response;
    return {
      id: credential.id,
      rawId: bufferToBase64url(credential.rawId),
      type: credential.type,
      authenticatorAttachment: credential.authenticatorAttachment || undefined,
      clientExtensionResults: credential.getClientExtensionResults
        ? credential.getClientExtensionResults()
        : {},
      response: {
        authenticatorData: bufferToBase64url(response.authenticatorData),
        clientDataJSON: bufferToBase64url(response.clientDataJSON),
        signature: bufferToBase64url(response.signature),
        // Present for a discoverable credential — it is how the server knows
        // which account signed without being told a username.
        userHandle: response.userHandle ? bufferToBase64url(response.userHandle) : undefined,
      },
    };
  }

  /** A first-guess label for a new passkey, so the user has something to edit. */
  function guessDeviceName() {
    var ua = navigator.userAgent || "";
    if (/iPhone/.test(ua)) return "iPhone";
    if (/iPad/.test(ua)) return "iPad";
    if (/Android/.test(ua)) return "Android device";
    if (/Macintosh/.test(ua)) return "Mac";
    if (/Windows/.test(ua)) return "Windows PC";
    if (/Linux/.test(ua)) return "Linux PC";
    return "Passkey";
  }

  window.PolarisWebAuthn = {
    supported: supported,
    unavailableHere: unavailableHere,
    platformAuthenticatorAvailable: platformAuthenticatorAvailable,
    create: create,
    get: get,
    describeError: describeError,
    guessDeviceName: guessDeviceName,
    bufferToBase64url: bufferToBase64url,
    base64urlToBuffer: base64urlToBuffer,
  };
})();
