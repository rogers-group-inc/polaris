// public/js/email-suggest.js
//
// Address-book suggestions for a plain comma-separated email field — the
// firmware upgrade dialog's "Email to" box on the desktop and the phone
// (business rule 93). The field stays a text input (what is typed is what is
// sent; PolarisAssetShared.fwParseEmails reads it); this only offers, under
// it, the Polaris users and address-book contacts whose name or address
// matches the entry being typed (GET /contacts/search — users ∪ contacts,
// already ranked for a typeahead). Picking one replaces that entry and adds
// ", " for the next.
//
// Needs `contacts:read` (every built-in role holds it). Without it, or when
// the search fails, the field simply behaves as a text box. The live
// organization directory is NOT searched — this is the address book.
//
//   PolarisEmailSuggest.attach(input, { onChange })
//
// The input's parent must be positioned (the markup wraps it in
// `position:relative`); the list is styled inline so it looks right on the
// phone, which does not load styles.css.

(function () {
  var MIN_CHARS = 2;
  var DEBOUNCE_MS = 250;
  var MAX_ITEMS = 8;

  /** The entry being typed: everything after the last comma / semicolon. */
  function currentToken(value) {
    var m = /[^,;]*$/.exec(value || "");
    return (m ? m[0] : "").trim();
  }

  /** `value` with its last entry replaced by `email`, ready for the next one. */
  function replaceToken(value, email) {
    var head = (value || "").replace(/[^,;]*$/, "");
    return (head ? head.replace(/\s*$/, " ") : "") + email + ", ";
  }

  /** Addresses already in the box, lower-cased — not offered again. */
  function chosen(value) {
    return (value || "").split(/[,;\s]+/).map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function attach(input, opts) {
    if (!input || input._emailSuggest) return;
    opts = opts || {};
    var list = document.createElement("div");
    list.className = "email-suggest";
    list.setAttribute("role", "listbox");
    var st = list.style;
    st.position = "absolute"; st.left = "0"; st.right = "0"; st.top = "calc(100% + 2px)";
    st.zIndex = "1300"; // above the modal / sheet
    st.background = "var(--color-bg-primary, var(--bg, #fff))";
    st.border = "1px solid var(--color-border, var(--border, #ccc))";
    st.borderRadius = "6px"; st.maxHeight = "220px"; st.overflowY = "auto";
    st.boxShadow = "0 6px 18px rgba(0,0,0,0.3)"; st.display = "none";
    input.parentNode.appendChild(list);
    input.setAttribute("autocomplete", "off");

    var items = [];
    var idx = -1;
    var timer = null;

    function close() { list.style.display = "none"; items = []; idx = -1; }
    function paint() {
      if (!items.length) { close(); return; }
      list.innerHTML = items.map(function (e, i) {
        var name = e.name && e.name.toLowerCase() !== e.email.toLowerCase() ? esc(e.name) + " " : "";
        return '<div class="email-suggest-item" role="option" data-i="' + i + '" style="padding:6px 9px;font-size:0.85rem;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis' +
          (i === idx ? ";background:var(--color-bg-secondary, rgba(127,127,127,0.15))" : "") + '">' +
          name + '<span style="opacity:0.7">' + (name ? "&lt;" + esc(e.email) + "&gt;" : esc(e.email)) + "</span></div>";
      }).join("");
      list.style.display = "block";
    }
    function pick(i) {
      var e = items[i];
      if (!e) return;
      input.value = replaceToken(input.value, e.email);
      close();
      input.focus();
      if (opts.onChange) opts.onChange();
    }

    input.addEventListener("input", function () {
      var q = currentToken(input.value);
      clearTimeout(timer);
      if (q.length < MIN_CHARS || typeof api === "undefined" || !api.contacts || !api.contacts.search) { close(); return; }
      timer = setTimeout(function () {
        api.contacts.search(q, false).then(function (r) {
          if (currentToken(input.value) !== q) return; // lost the race with newer typing
          var have = chosen(input.value.replace(/[^,;]*$/, ""));
          items = ((r && r.entries) || []).filter(function (e) {
            return e && e.email && have.indexOf(String(e.email).toLowerCase()) < 0;
          }).slice(0, MAX_ITEMS);
          idx = items.length ? 0 : -1;
          paint();
        }).catch(function () { close(); });
      }, DEBOUNCE_MS);
    });
    input.addEventListener("keydown", function (ev) {
      if (list.style.display === "none") return;
      if (ev.key === "ArrowDown") { ev.preventDefault(); idx = (idx + 1) % items.length; paint(); }
      else if (ev.key === "ArrowUp") { ev.preventDefault(); idx = (idx - 1 + items.length) % items.length; paint(); }
      else if (ev.key === "Enter" || ev.key === "Tab") { if (idx >= 0) { ev.preventDefault(); pick(idx); } }
      else if (ev.key === "Escape") { ev.stopPropagation(); close(); }
    });
    input.addEventListener("blur", function () { setTimeout(close, 150); });
    // mousedown + preventDefault keeps focus in the field so blur does not race the pick.
    list.addEventListener("mousedown", function (ev) {
      var it = ev.target.closest && ev.target.closest(".email-suggest-item");
      if (!it) return;
      ev.preventDefault();
      pick(Number(it.getAttribute("data-i")));
    });
    input._emailSuggest = { close: close };
  }

  window.PolarisEmailSuggest = { attach: attach, currentToken: currentToken, replaceToken: replaceToken };
})();
