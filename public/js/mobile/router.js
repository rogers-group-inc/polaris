// public/js/mobile/router.js — Tiny hash-based router for the mobile app.
//
// Hash shape:
//   #login                    → unauthenticated entry
//   #alerts | #assets         → primary tabs (alerts is home)
//   #networks | #chat | #more
//   #search | #map            → route tabs (no navbar slot)
//   #more/<sub>               → sub-pages of the More tab (blocks, subnets, …)
//   #asset/<id>               → asset detail
//   #subnet/<id>              → subnet detail
//
// The router is dumb on purpose — it parses the current hash, fires a single
// `onChange(route)` callback, and pushes new states via `go()`. All actual
// rendering happens in app.js.

(function () {
  function parse(hash) {
    var raw = (hash || "").replace(/^#/, "").trim();
    if (!raw) return { name: "", parts: [], full: "" };
    var parts = raw.split("/");
    return { name: parts[0], parts: parts.slice(1), full: raw };
  }

  function go(target, opts) {
    opts = opts || {};
    var current = window.location.hash.replace(/^#/, "");
    if (current === target) {
      // Same route — refire so callers can refresh.
      _emit();
      return;
    }
    if (opts.replace) {
      var url = window.location.pathname + window.location.search + "#" + target;
      window.history.replaceState(null, "", url);
      _emit();
    } else {
      window.location.hash = target;
    }
  }

  var _handler = null;

  function _emit() {
    if (_handler) _handler(parse(window.location.hash));
  }

  function onChange(handler) {
    _handler = handler;
    _emit();
  }

  window.addEventListener("hashchange", _emit);

  window.PolarisRouter = {
    parse: parse,
    go: go,
    onChange: onChange,
    current: function () { return parse(window.location.hash); },
  };
})();
