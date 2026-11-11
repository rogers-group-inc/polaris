/**
 * public/js/share-link.js — the Share button on the asset, network and block
 * slide-overs (desktop) and the asset and network sheets (phone).
 *
 * WHAT IS SHARED. A surface-neutral link — `/assets/<id>`, `/networks/<id>`,
 * `/blocks/<id>` — that the server resolves per request from the user-agent
 * (src/utils/assetOpenLink.ts, the route in src/app.ts). The sharer cannot
 * know whether the recipient opens it on a laptop or a phone, so the link
 * never names a front end: a link shared from the desktop opens the phone's
 * sheet on a phone, and the reverse. Signed out, the route remembers itself
 * as the login target, so the recipient lands on the thing after any of the
 * five login paths. Nothing is granted by the link: the recipient's own role
 * still decides what the page shows.
 *
 * THE ORIGIN. Built from `location.origin` — the address the sharer is using,
 * which is the one most likely to work for a colleague — never
 * POLARIS_PUBLIC_URL, which may be unset.
 *
 * HOW IT IS SENT. On a phone the native share sheet (Teams, Messages, mail…)
 * when the browser has one; on the desktop the link is copied and a toast says
 * so — the Windows / macOS share sheets are a detour from "paste it in a
 * chat". The Web Share and async Clipboard APIs both need a secure context and
 * Polaris supports plain-HTTP installs, so each falls back: share → copy,
 * clipboard API → a hidden textarea + execCommand, and if that fails too, a
 * prompt holding the link to copy by hand.
 *
 * Loaded statically on every desktop page that loads app-panels.js and on
 * mobile.html. Global: PolarisShare.
 */
(function () {
  var PATHS = { asset: "/assets/", network: "/networks/", block: "/blocks/" };
  var NOUN = { asset: "device", network: "network", block: "IP block" };

  function url(kind, id) {
    if (!PATHS[kind] || !id) return null;
    var origin = (window.location && window.location.origin) || "";
    return origin + PATHS[kind] + encodeURIComponent(String(id));
  }

  function _execCopy(text) {
    try {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.top = "-1000px";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand && document.execCommand("copy");
      document.body.removeChild(ta);
      return !!ok;
    } catch (_) {
      return false;
    }
  }

  // Resolves true when the text reached the clipboard.
  function copyText(text) {
    var clip = window.isSecureContext && navigator.clipboard && navigator.clipboard.writeText;
    if (clip) {
      return navigator.clipboard.writeText(text).then(
        function () { return true; },
        function () { return _execCopy(text); }
      );
    }
    return Promise.resolve(_execCopy(text));
  }

  // The phone's snackbar when there is one (mobile.html), else the desktop toast.
  function _toast(msg) {
    if (window.PolarisTabs && typeof window.PolarisTabs.showSnackbar === "function") {
      window.PolarisTabs.showSnackbar(msg);
    } else if (typeof window.showToast === "function") {
      window.showToast(msg, "success");
    }
  }

  function _copyAndTell(link, kind) {
    return copyText(link).then(function (ok) {
      if (ok) {
        _toast("Link copied — anyone with a Polaris account can open this " + (NOUN[kind] || "item"));
        return "copied";
      }
      // Last resort: the link in a box to copy by hand.
      try { window.prompt("Copy this link", link); } catch (_) {}
      return "shown";
    });
  }

  /**
   * Share one thing. opts.title names it in the share sheet ("core-sw-01");
   * opts.native: true prefers the system share sheet (the phone).
   * Resolves "shared" | "copied" | "shown" | "cancelled" | null (bad input).
   */
  function share(kind, id, opts) {
    var o = opts || {};
    var link = url(kind, id);
    if (!link) return Promise.resolve(null);
    var data = { title: o.title ? String(o.title) : "Polaris", url: link };
    if (o.native && typeof navigator !== "undefined" && typeof navigator.share === "function"
        && (!navigator.canShare || navigator.canShare(data))) {
      return navigator.share(data).then(
        function () { return "shared"; },
        function (err) {
          // The operator closed the sheet — not a failure, nothing to say.
          if (err && err.name === "AbortError") return "cancelled";
          return _copyAndTell(link, kind);
        }
      );
    }
    return _copyAndTell(link, kind);
  }

  window.PolarisShare = { url: url, share: share, copyText: copyText };
})();
