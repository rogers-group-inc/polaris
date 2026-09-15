/**
 * public/js/table-sf.js — Per-column sort + inline filter for data tables
 *
 * Usage:
 *   var sf = new TableSF("tbody-id", onChange);
 *   var processed = sf.apply(rawData);
 *
 * Mark sortable/filterable columns with data-sf-key and data-sf-type attributes:
 *   <th data-sf-key="name" data-sf-type="string">Name</th>
 *
 * Supported types: string (default), number, date, ip, array
 * Nested keys work:  data-sf-key="block.name"  or  data-sf-key="_count.subnets"
 *
 * Multi-select dropdown filter: add data-sf-options="value1|value2|value3" to
 * render a checkbox popover instead of a free-text input. Each option may use
 * "value=Label" form to override the displayed label (defaults to capitalized
 * value). Selected values are matched case-insensitively against the row's
 * value via exact equality, and the filter is stored as an array.
 */

// Shared debounce. Declared at the top of table-sf.js (loaded before every
// consumer in every HTML) so TableSF._wireTextFilter can reach it without
// requiring each host page to redeclare it locally. Also reachable by any
// page-level code via the same global hoist (e.g. blocks.js's tag filter).
function debounce(fn, ms) {
  var timer;
  return function () {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}

function TableSF(tbodyId, onChange) {
  var tbody = document.getElementById(tbodyId);
  this._thead = tbody ? tbody.closest("table").querySelector("thead") : null;
  this._onChange = onChange;
  this._sortKey = null;
  this._sortDir = "asc";
  this._filters = {};
  if (this._thead) this._setup();
}

TableSF.prototype._setup = function () {
  var self = this;
  this._thead.querySelectorAll("th[data-sf-key]").forEach(function (th) {
    var key     = th.getAttribute("data-sf-key");
    var label   = th.textContent.trim();
    var optsRaw = th.getAttribute("data-sf-options");

    th.classList.add("sf-th");

    var headerHtml =
      '<div class="sf-header">' +
        '<span class="sf-label">' + escapeHtml(label) + '</span>' +
        '<span class="sf-sort-icon">⇅</span>' +
      '</div>';

    var typeAttr = th.getAttribute("data-sf-type") || "string";
    // data-sf-nofilter → sortable but NOT filterable: render the header + sort
    // icon only, and skip the filter-control wiring below. Sorting stays wired
    // (it hangs off .sf-header, independent of any filter control).
    var noFilter = th.hasAttribute("data-sf-nofilter");
    if (noFilter) {
      th.innerHTML = headerHtml;
    } else if (optsRaw != null) {
      // Empty data-sf-options="" marks the column as a dynamic multi-select;
      // setColumnOptions() will populate the checkbox list once data loads.
      var checks = optsRaw.trim()
        ? self._renderOptionList(self._parseOptions(optsRaw))
        : "";
      th.innerHTML = headerHtml +
        '<div class="sf-filter-multi">' +
          '<button type="button" class="sf-filter sf-multi-button" title="Filter by value">All</button>' +
          '<div class="sf-multi-popover" hidden>' + checks + '</div>' +
        '</div>';
    } else if (typeAttr === "date") {
      th.innerHTML = headerHtml +
        '<div class="sf-filter-date">' +
          '<button type="button" class="sf-filter sf-date-button" title="Filter by date range">Any date</button>' +
          '<div class="sf-multi-popover sf-date-popover" hidden>' +
            '<label class="sf-date-row"><span>From</span><input type="date" data-sf-date="from"></label>' +
            '<label class="sf-date-row"><span>To</span><input type="date" data-sf-date="to"></label>' +
            '<div class="sf-date-actions"><button type="button" class="sf-btn-clear">Clear</button></div>' +
          '</div>' +
        '</div>';
    } else {
      th.innerHTML = headerHtml +
        '<div class="sf-filter-text">' +
          '<button type="button" class="sf-filter-op" title="Filter mode">▾</button>' +
          '<input class="sf-filter" type="text" placeholder="filter…"' +
            ' title="Type to filter. Prefix with ! to exclude rows (e.g. !foo).">' +
          '<div class="sf-multi-popover sf-op-popover" hidden>' +
            '<div class="sf-op-row" data-op="contains">Contains text</div>' +
            '<div class="sf-op-row" data-op="not-contains">Does not contain</div>' +
            '<div class="sf-op-row" data-op="empty">Is empty</div>' +
            '<div class="sf-op-row" data-op="notempty">Is not empty</div>' +
          '</div>' +
        '</div>';
    }

    th.querySelector(".sf-header").addEventListener("click", function () {
      if (self._sortKey === key) {
        self._sortDir = self._sortDir === "asc" ? "desc" : "asc";
      } else {
        self._sortKey = key;
        self._sortDir = "asc";
      }
      self._updateIcons();
      self._onChange();
    });

    if (noFilter) {
      // Sort-only column — no filter control to wire.
    } else if (optsRaw != null) {
      var wrap = th.querySelector(".sf-filter-multi");
      var btn  = wrap.querySelector(".sf-multi-button");
      var pop  = wrap.querySelector(".sf-multi-popover");

      wrap.addEventListener("click", function (e) { e.stopPropagation(); });
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        var willOpen = pop.hasAttribute("hidden");
        document.querySelectorAll(".sf-multi-popover").forEach(function (p) {
          p.setAttribute("hidden", "");
        });
        if (willOpen) {
          pop.removeAttribute("hidden");
          self._positionPopover(btn, pop);
        }
      });
      pop.addEventListener("change", function () {
        var selected = Array.prototype.slice.call(
          pop.querySelectorAll('input[type="checkbox"]:checked')
        ).map(function (cb) { return cb.value; });
        if (selected.length) self._filters[key] = selected;
        else                  delete self._filters[key];
        self._updateMultiButtonLabel(th);
        self._onChange();
      });
    } else if (typeAttr === "date") {
      self._wireDateFilter(th, key);
    } else {
      self._wireTextFilter(th, key);
    }
  });

  TableSF._wireDocClose();
};

// Document-wide "close every open popover" wiring, installed once per page.
// Popovers are position:fixed, so an ancestor scroll or a resize would leave
// them floating away from their button — hence the capture-phase scroll close.
// But a popover has its own overflow-y (max-height), and its INTERNAL scroll
// must not close it: wheel/scrollbar events whose target is inside a popover
// are ignored, and a scrollbar drag that starts inside one is ignored on the
// resulting click too (the mouseup lands outside, so the click targets a
// common ancestor and would otherwise dismiss the popover mid-drag).
TableSF._wireDocClose = function () {
  if (TableSF._docWired) return;
  TableSF._docWired = true;

  var inPopover = function (node) {
    return !!(node && node.closest && node.closest(".sf-multi-popover"));
  };
  var closeAll = function () {
    document.querySelectorAll(".sf-multi-popover").forEach(function (p) {
      p.setAttribute("hidden", "");
    });
  };
  var pressInPopover = false;

  document.addEventListener("mousedown", function (e) {
    pressInPopover = inPopover(e.target);
  }, true);
  document.addEventListener("click", function (e) {
    var skip = pressInPopover || inPopover(e.target);
    pressInPopover = false;
    if (!skip) closeAll();
  });
  // Only a scroll that MOVED the popover's button is a reason to close it (the
  // showRowMenu precedent in app.js): the dashboard's NOC auto-scroll creeps
  // every overflowing widget body by a pixel every 80ms, and closing on those
  // made a filter dropdown in the asset-details slide-over vanish the instant
  // it opened while a dashboard sat behind the panel. A scroll in a container
  // that doesn't hold the button leaves the popover correctly placed.
  window.addEventListener("scroll", function (e) {
    var t = e && e.target;
    if (inPopover(t)) return;
    // Document-level scroll (target is the Document node) moves everything.
    var docLevel = !t || t.nodeType === 9 || typeof t.contains !== "function";
    document.querySelectorAll(".sf-multi-popover").forEach(function (p) {
      if (p.hasAttribute("hidden")) return;
      if (docLevel || t.contains(TableSF._popoverAnchor(p))) p.setAttribute("hidden", "");
    });
  }, true);
  window.addEventListener("resize", closeAll);
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closeAll();
  });
};

TableSF.prototype._wireTextFilter = function (th, key) {
  var self = this;
  var wrap = th.querySelector(".sf-filter-text");
  var opBtn = wrap.querySelector(".sf-filter-op");
  var inp   = wrap.querySelector(".sf-filter");
  var pop   = wrap.querySelector(".sf-op-popover");

  wrap.addEventListener("click", function (e) { e.stopPropagation(); });
  inp.addEventListener("click", function (e) { e.stopPropagation(); });

  function commitText() {
    var v = inp.value.trim();
    var raw = self._filters[key];
    var op = "contains";
    if (raw && typeof raw === "object" && raw.op === "not-contains") op = "not-contains";
    if (op === "contains") {
      if (v && v !== "!") self._filters[key] = v;
      else                delete self._filters[key];
    } else {
      if (v) self._filters[key] = { op: "not-contains", q: v };
      else   delete self._filters[key];
    }
    self._updateTextOpUI(th, key);
    self._onChange();
  }
  inp.addEventListener("input", debounce(commitText, 200));

  opBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    var willOpen = pop.hasAttribute("hidden");
    document.querySelectorAll(".sf-multi-popover").forEach(function (p) { p.setAttribute("hidden", ""); });
    if (willOpen) {
      pop.removeAttribute("hidden");
      self._positionPopover(opBtn, pop);
    }
  });
  pop.addEventListener("click", function (e) {
    var row = e.target.closest(".sf-op-row");
    if (!row) return;
    var op = row.getAttribute("data-op");
    pop.setAttribute("hidden", "");
    if (op === "empty" || op === "notempty") {
      self._filters[key] = { op: op };
    } else if (op === "not-contains") {
      var v = inp.value.trim();
      if (v) self._filters[key] = { op: "not-contains", q: v };
      else   delete self._filters[key];
    } else {
      // contains (default) — drop any prior object form, leave plain text input
      var v2 = inp.value.trim();
      if (v2) self._filters[key] = v2;
      else    delete self._filters[key];
    }
    self._updateTextOpUI(th, key);
    self._onChange();
  });
};

TableSF.prototype._updateTextOpUI = function (th, key) {
  var wrap = th.querySelector(".sf-filter-text");
  if (!wrap) return;
  var opBtn = wrap.querySelector(".sf-filter-op");
  var inp   = wrap.querySelector(".sf-filter");
  var raw   = this._filters[key];
  var op    = "contains";
  if (raw && typeof raw === "object" && raw.op) op = raw.op;
  if (op === "empty" || op === "notempty") {
    // Don't write a sentinel value into the input — keeping value empty means
    // switching back to "contains" doesn't accidentally commit "(is empty)" as
    // the search query. Placeholder communicates the state instead.
    inp.value = "";
    inp.readOnly = true;
    inp.classList.add("sf-filter-readonly");
    inp.placeholder = (op === "empty" ? "(is empty)" : "(is not empty)");
  } else {
    inp.readOnly = false;
    inp.classList.remove("sf-filter-readonly");
    inp.placeholder = "filter…";
    if (raw && typeof raw === "object" && raw.op === "not-contains") {
      if (inp.value !== raw.q) inp.value = raw.q || "";
    } else if (typeof raw === "string") {
      if (inp.value !== raw) inp.value = raw;
    }
  }
  var active = (raw != null);
  opBtn.classList.toggle("sf-filter-op-active", !!active);
  opBtn.title = "Filter mode — current: " + (
    op === "empty"        ? "is empty" :
    op === "notempty"     ? "is not empty" :
    op === "not-contains" ? "does not contain" :
                            "contains text"
  );
};

TableSF.prototype._wireDateFilter = function (th, key) {
  var self = this;
  var wrap = th.querySelector(".sf-filter-date");
  var btn  = wrap.querySelector(".sf-date-button");
  var pop  = wrap.querySelector(".sf-date-popover");
  var fromInp = pop.querySelector('input[data-sf-date="from"]');
  var toInp   = pop.querySelector('input[data-sf-date="to"]');
  var clearBtn = pop.querySelector(".sf-btn-clear");

  wrap.addEventListener("click", function (e) { e.stopPropagation(); });
  btn.addEventListener("click", function (e) {
    e.stopPropagation();
    var willOpen = pop.hasAttribute("hidden");
    document.querySelectorAll(".sf-multi-popover").forEach(function (p) { p.setAttribute("hidden", ""); });
    if (willOpen) {
      pop.removeAttribute("hidden");
      self._positionPopover(btn, pop);
    }
  });

  function commit() {
    var from = fromInp.value || null;
    var to   = toInp.value   || null;
    if (!from && !to) delete self._filters[key];
    else self._filters[key] = { type: "date", from: from, to: to };
    self._updateDateButtonLabel(th, key);
    self._onChange();
  }
  fromInp.addEventListener("change", commit);
  toInp.addEventListener("change", commit);
  clearBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    fromInp.value = "";
    toInp.value = "";
    delete self._filters[key];
    self._updateDateButtonLabel(th, key);
    self._onChange();
  });
};

TableSF.prototype._updateDateButtonLabel = function (th, key) {
  var btn = th.querySelector(".sf-date-button");
  if (!btn) return;
  var raw = this._filters[key];
  function fmt(s) {
    if (!s) return "";
    var d = new Date(s + "T00:00:00");
    if (isNaN(d.getTime())) return s;
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }
  if (raw && raw.type === "date" && (raw.from || raw.to)) {
    var label;
    if (raw.from && raw.to) label = fmt(raw.from) + " – " + fmt(raw.to);
    else if (raw.from)      label = "Since " + fmt(raw.from);
    else                    label = "Until " + fmt(raw.to);
    btn.textContent = label;
    btn.classList.add("sf-multi-active");
  } else {
    btn.textContent = "Any date";
    btn.classList.remove("sf-multi-active");
  }
};

TableSF.prototype._isEmptyValue = function (v) {
  if (v == null) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  return false;
};

TableSF.prototype._parseOptions = function (raw) {
  return String(raw || "").split("|").filter(function (s) { return s.length > 0; }).map(function (entry) {
    var idx = entry.indexOf("=");
    if (idx >= 0) return { value: entry.slice(0, idx), label: entry.slice(idx + 1) };
    return { value: entry, label: entry.charAt(0).toUpperCase() + entry.slice(1).replace(/_/g, " ") };
  });
};

TableSF.prototype._renderOptionList = function (opts) {
  return opts.map(function (o) {
    return '<label class="sf-multi-option">' +
      '<input type="checkbox" value="' + escapeHtml(o.value) + '">' +
      '<span>' + escapeHtml(o.label) + '</span></label>';
  }).join("");
};

// Repopulate a multi-select column's checkbox list at runtime. Used when
// options are derived from the loaded data (e.g. integration names). Existing
// checked values are preserved if they still exist in the new option set.
TableSF.prototype.setColumnOptions = function (key, options) {
  if (!this._thead) return;
  var th = this._thead.querySelector('th[data-sf-key="' + key + '"]');
  if (!th) return;
  var pop = th.querySelector(".sf-multi-popover");
  if (!pop) return;
  var prevChecked = Array.prototype.slice.call(
    pop.querySelectorAll('input[type="checkbox"]:checked')
  ).map(function (cb) { return cb.value; });
  // Accept either an array of strings or { value, label } objects.
  var normalized = (options || []).map(function (o) {
    if (typeof o === "string") return { value: o, label: o };
    return { value: String(o.value), label: String(o.label != null ? o.label : o.value) };
  });
  pop.innerHTML = this._renderOptionList(normalized);
  var preserved = [];
  pop.querySelectorAll('input[type="checkbox"]').forEach(function (cb) {
    if (prevChecked.indexOf(cb.value) >= 0) { cb.checked = true; preserved.push(cb.value); }
  });
  // Also preserve any saved-pref values that aren't in the live DOM yet.
  var saved = this._filters[key];
  if (Array.isArray(saved)) {
    pop.querySelectorAll('input[type="checkbox"]').forEach(function (cb) {
      if (!cb.checked && saved.indexOf(cb.value) >= 0) { cb.checked = true; preserved.push(cb.value); }
    });
  }
  if (preserved.length) this._filters[key] = preserved;
  else delete this._filters[key];
  this._updateMultiButtonLabel(th);
};

/**
 * Nearest ancestor that makes a position:fixed descendant lay out against
 * ITSELF instead of the viewport — transform / perspective / filter /
 * backdrop-filter / will-change of those / contain all establish one (CSS
 * Position, "containing block"). Returns null when there is none, which is the
 * case on every ordinary list page.
 *
 * This exists because `.slideover` carries `transform: translateX(…)` for its
 * slide animation and `.modal` a `translateY(…)` — and a transform still
 * establishes the containing block at its identity value, so it applies while
 * the panel sits fully open at translateX(0). Every filter popover inside the
 * asset-details slide-over was therefore offset by the panel's own left edge and
 * landed roughly half a screen right of its button (vertically correct, since
 * the panel's top is 0). The gear's column chooser never showed the bug because
 * it appends itself to <body>; these popovers can't — they live inside their
 * <th>, which is where setColumnOptions / restoreFilterUI /
 * _updateMultiButtonLabel all go looking for them — so the offset is subtracted
 * here instead.
 */
TableSF._fixedHost = function (el) {
  var n = el && el.parentElement;
  while (n && n !== document.body && n !== document.documentElement) {
    var cs = getComputedStyle(n);
    if ((cs.transform && cs.transform !== "none") ||
        (cs.perspective && cs.perspective !== "none") ||
        (cs.filter && cs.filter !== "none") ||
        (cs.backdropFilter && cs.backdropFilter !== "none") ||
        /transform|perspective|filter/.test(cs.willChange || "") ||
        /paint|layout|strict|content/.test(cs.contain || "")) {
      return n;
    }
    n = n.parentElement;
  }
  return null;
};

// The element a popover is anchored to, for the scroll-close containment test.
// Stamped by every open path; falls back to the popover's own parent, which for
// the in-header filters holds both the button and the popover.
TableSF._popoverAnchor = function (pop) {
  return (pop && pop._sfAnchor) || (pop && pop.parentElement) || pop;
};

TableSF.prototype._positionPopover = function (btn, pop) {
  pop._sfAnchor = btn;
  var r = btn.getBoundingClientRect();
  var top  = r.bottom + 2;
  var left = r.left;
  var host = TableSF._fixedHost(pop);
  if (host) {
    // The containing block is the host's PADDING box, so its border comes off
    // too (.slideover has a 1px left border).
    var hr  = host.getBoundingClientRect();
    var hcs = getComputedStyle(host);
    top  -= hr.top  + (parseFloat(hcs.borderTopWidth)  || 0);
    left -= hr.left + (parseFloat(hcs.borderLeftWidth) || 0);
  }
  pop.style.position = "fixed";
  pop.style.top  = top + "px";
  pop.style.left = left + "px";
  pop.style.minWidth = r.width + "px";
};

TableSF.prototype._updateMultiButtonLabel = function (th) {
  var btn = th.querySelector(".sf-multi-button");
  var pop = th.querySelector(".sf-multi-popover");
  if (!btn || !pop) return;
  var checked = pop.querySelectorAll('input[type="checkbox"]:checked');
  if (checked.length === 0) {
    btn.textContent = "All";
    btn.classList.remove("sf-multi-active");
  } else if (checked.length === 1) {
    btn.textContent = checked[0].nextElementSibling.textContent;
    btn.classList.add("sf-multi-active");
  } else if (checked.length === pop.querySelectorAll('input[type="checkbox"]').length) {
    btn.textContent = "All";
    btn.classList.remove("sf-multi-active");
  } else {
    btn.textContent = checked.length + " selected";
    btn.classList.add("sf-multi-active");
  }
};

TableSF.prototype.restoreFilterUI = function () {
  var self = this;
  if (!self._thead) return;
  self._thead.querySelectorAll("th[data-sf-key]").forEach(function (th) {
    var key = th.getAttribute("data-sf-key");
    var raw = self._filters[key];
    var multi = th.querySelector(".sf-filter-multi");
    var dateWrap = th.querySelector(".sf-filter-date");
    var textWrap = th.querySelector(".sf-filter-text");
    if (multi) {
      var values = Array.isArray(raw) ? raw : [];
      if (!Array.isArray(raw) && raw != null) delete self._filters[key];
      multi.querySelectorAll('input[type="checkbox"]').forEach(function (cb) {
        cb.checked = values.indexOf(cb.value) >= 0;
      });
      self._updateMultiButtonLabel(th);
    } else if (dateWrap) {
      var fromInp = dateWrap.querySelector('input[data-sf-date="from"]');
      var toInp   = dateWrap.querySelector('input[data-sf-date="to"]');
      if (raw && raw.type === "date") {
        if (fromInp) fromInp.value = raw.from || "";
        if (toInp)   toInp.value   = raw.to   || "";
      } else {
        if (raw != null) delete self._filters[key];
        if (fromInp) fromInp.value = "";
        if (toInp)   toInp.value   = "";
      }
      self._updateDateButtonLabel(th, key);
    } else if (textWrap) {
      var inp = textWrap.querySelector(".sf-filter");
      if (inp) {
        if (typeof raw === "string") {
          inp.value = raw;
        } else if (raw && typeof raw === "object" && raw.op === "not-contains") {
          inp.value = raw.q || "";
        } else if (raw && typeof raw === "object" && (raw.op === "empty" || raw.op === "notempty")) {
          // _updateTextOpUI sets the readonly placeholder
        } else {
          inp.value = "";
          if (raw != null) delete self._filters[key];
        }
      }
      self._updateTextOpUI(th, key);
    }
  });
};

TableSF.prototype.clearFilters = function () {
  this._filters = {};
  this.restoreFilterUI();
};

TableSF.prototype._updateIcons = function () {
  var self = this;
  this._thead.querySelectorAll("th[data-sf-key]").forEach(function (th) {
    var icon = th.querySelector(".sf-sort-icon");
    if (!icon) return;
    var active = th.getAttribute("data-sf-key") === self._sortKey;
    icon.textContent = active ? (self._sortDir === "asc" ? "▲" : "▼") : "⇅";
    icon.classList.toggle("sf-sort-active", active);
  });
};

// Key paths are static per column, so split once — _val runs per row per
// filter key and (pre-decorate) ran per sort comparison.
TableSF.prototype._path = function (key) {
  var c = this._pathCache || (this._pathCache = {});
  return c[key] || (c[key] = key.split("."));
};

TableSF.prototype._val = function (row, key) {
  var v = row;
  var path = this._path(key);
  for (var i = 0; i < path.length; i++) v = v != null ? v[path[i]] : null;
  if (Array.isArray(v)) return v.join(" ");
  return v == null ? "" : v;
};

// Same path resolution as _val but without coercing null/array — used by the
// is-empty / is-not-empty / date-range filters that need to inspect the raw
// underlying value (so a literal "0" or false isn't mistaken for null, and so
// a missing string and an empty array are both correctly classified as empty).
TableSF.prototype._rawVal = function (row, key) {
  var v = row;
  var path = this._path(key);
  for (var i = 0; i < path.length; i++) v = v != null ? v[path[i]] : null;
  return v;
};

TableSF.prototype._ipNum = function (ip) {
  var s = String(ip || "").trim();
  if (!s) return 0n;
  var slash = s.indexOf("/");
  if (slash >= 0) s = s.slice(0, slash);
  if (s.indexOf(":") >= 0) return this._ipv6Num(s);
  var p = s.split(".");
  if (p.length !== 4) return 0n;
  var n = 0n;
  for (var i = 0; i < 4; i++) n = (n << 8n) | BigInt(parseInt(p[i], 10) || 0);
  return n;
};

TableSF.prototype._ipv6Num = function (addr) {
  // Convert a trailing dotted-quad (IPv4-mapped) into two hex groups.
  var lastColon = addr.lastIndexOf(":");
  var tail = addr.slice(lastColon + 1);
  if (tail.indexOf(".") >= 0) {
    var o = tail.split(".");
    if (o.length === 4) {
      var hi = ((parseInt(o[0], 10) || 0) << 8 | (parseInt(o[1], 10) || 0)).toString(16);
      var lo = ((parseInt(o[2], 10) || 0) << 8 | (parseInt(o[3], 10) || 0)).toString(16);
      addr = addr.slice(0, lastColon + 1) + hi + ":" + lo;
    }
  }

  // Expand "::" shorthand into enough zero groups to reach 8 total.
  var parts;
  var dbl = addr.indexOf("::");
  if (dbl >= 0) {
    var leftStr  = addr.slice(0, dbl);
    var rightStr = addr.slice(dbl + 2);
    var left  = leftStr  ? leftStr.split(":")  : [];
    var right = rightStr ? rightStr.split(":") : [];
    var missing = 8 - left.length - right.length;
    if (missing < 0) return 0n;
    var middle = [];
    for (var i = 0; i < missing; i++) middle.push("0");
    parts = left.concat(middle).concat(right);
  } else {
    parts = addr.split(":");
  }

  if (parts.length !== 8) return 0n;
  var n = 0n;
  for (var j = 0; j < 8; j++) n = (n << 16n) | BigInt(parseInt(parts[j] || "0", 16) || 0);
  return n;
};

TableSF.prototype.apply = function (data) {
  var self = this;
  var result = data;

  var fKeys = Object.keys(self._filters);
  if (fKeys.length) {
    result = result.filter(function (row) {
      return fKeys.every(function (k) {
        var raw = self._filters[k];
        if (Array.isArray(raw)) {
          if (!raw.length) return true;
          // When the row value itself is an array, a single row can satisfy
          // multiple filter options (e.g. a "Monitored Up" asset matches both
          // the "Monitored" and the "Up" filter selections). Check membership
          // instead of the default scalar string-equality.
          var rawV = self._rawVal(row, k);
          var rowVals = Array.isArray(rawV)
            ? rawV.map(function (v) { return String(v).toLowerCase(); })
            : [String(self._val(row, k)).toLowerCase()];
          for (var i = 0; i < raw.length; i++) {
            var sel = String(raw[i]).toLowerCase();
            for (var j = 0; j < rowVals.length; j++) {
              if (rowVals[j] === sel) return true;
            }
          }
          return false;
        }
        if (raw && typeof raw === "object") {
          // Operator-based text filter
          if (raw.op === "empty")    return self._isEmptyValue(self._rawVal(row, k));
          if (raw.op === "notempty") return !self._isEmptyValue(self._rawVal(row, k));
          if (raw.op === "not-contains") {
            var qn = String(raw.q || "").toLowerCase();
            if (!qn) return true;
            return !String(self._val(row, k)).toLowerCase().includes(qn);
          }
          // Date range
          if (raw.type === "date") {
            var rv2 = self._rawVal(row, k);
            if (rv2 == null || rv2 === "") return false;
            var d = new Date(rv2);
            if (isNaN(d.getTime())) return false;
            if (raw.from) {
              var fromD = new Date(raw.from + "T00:00:00");
              if (d < fromD) return false;
            }
            if (raw.to) {
              var toD = new Date(raw.to + "T23:59:59.999");
              if (d > toD) return false;
            }
            return true;
          }
          return true;
        }
        var exclude = raw.charAt(0) === "!";
        var q       = (exclude ? raw.slice(1) : raw).toLowerCase();
        if (!q) return true;
        var match = String(self._val(row, k)).toLowerCase().includes(q);
        return exclude ? !match : match;
      });
    });
  }

  if (self._sortKey) {
    var k    = self._sortKey;
    var thEl = self._thead.querySelector('th[data-sf-key="' + k + '"]');
    var type = thEl ? (thEl.getAttribute("data-sf-type") || "string") : "string";
    var dir  = self._sortDir === "asc" ? 1 : -1;
    // Decorate-sort-undecorate: resolve each row's sort key ONCE. The old
    // comparator re-walked the key path and re-parsed dates / BigInt IPs on
    // both sides of every comparison — ~2·n·log₂(n) conversions per sort
    // click at 2000 rows, on a module shared by five list pages.
    var decorated = result.map(function (row) {
      var v = self._val(row, k);
      var sv;
      if (type === "number")    sv = parseFloat(v);
      else if (type === "date") sv = new Date(v).getTime();
      else if (type === "ip")   sv = self._ipNum(v);
      else                      sv = String(v).toLowerCase();
      return { row: row, v: sv };
    });
    decorated.sort(function (a, b) {
      if (type === "number" || type === "date") return (a.v - b.v) * dir;
      return (a.v < b.v ? -1 : a.v > b.v ? 1 : 0) * dir;
    });
    result = decorated.map(function (d) { return d.row; });
  }

  return result;
};

/**
 * setupColumnLayout(tableEl, options) — Resizable column widths + show/hide/
 * reorder column chooser. Independent of TableSF (works on any <table>), but
 * when a table uses both, construct TableSF FIRST: TableSF._setup rebuilds each
 * header th via innerHTML, which wipes the resize handles this helper appends.
 *
 * Each <th> is given a stable column id derived from data-sf-key, then
 * data-col-id, then "__col<index>". Columns marked data-col-required="true"
 * (or with class "cb-col" / "fav-col") cannot be hidden via the chooser, and
 * are anchors for reordering: they hold their authored index while the other
 * columns are dragged around them.
 *
 * Reordering physically moves the <th>, its <col>, and each body row's cells,
 * because there is no CSS way to permute table columns. Pages that rebuild
 * their tbody keep working without changes — a MutationObserver re-applies the
 * order after each render (installed only once the order is non-default).
 *
 * options:
 *   chooserButton  — element; clicking it toggles the column chooser popover
 *   onChange       — callback invoked when widths or hidden cols change
 *   labelFor       — fn(thEl) -> string label override for the chooser entry
 *
 * Returns { getPrefs, setPrefs, openChooser, refresh } so callers can persist
 * { widths, hidden } themselves alongside their other prefs.
 */
function setupColumnLayout(tableEl, options) {
  options = options || {};
  if (!tableEl) return null;
  var thead = tableEl.querySelector("thead");
  if (!thead) return null;
  var headerRow = thead.querySelector("tr");
  if (!headerRow) return null;
  var ths = Array.prototype.slice.call(headerRow.children);
  if (!ths.length) return null;

  var colIds = ths.map(function (th, i) {
    var id = th.getAttribute("data-sf-key") ||
             th.getAttribute("data-col-id") ||
             ("__col" + i);
    th.setAttribute("data-col-id", id);
    return id;
  });

  var required = {};
  // Fixed utility columns (checkbox / favorite star): never hidden, never
  // resized — no drag handle of their own and skipped when a neighboring drag
  // looks for the column to absorb its delta. Pinned to FIXED_COL_W below.
  var noResize = {};
  // Static-width columns (data-col-no-resize="true"): non-resizable like
  // noResize, but keep their own width (from the <th> style / measured) rather
  // than being pinned to the 20px utility width. For columns whose content is a
  // fixed-size token (enum badge, MAC) so they shouldn't be draggable.
  var fixedW = {};
  ths.forEach(function (th, i) {
    if (th.classList.contains("cb-col") || th.classList.contains("fav-col")) {
      required[colIds[i]] = true;
      noResize[colIds[i]] = true;
    }
    if (th.getAttribute("data-col-required") === "true") required[colIds[i]] = true;
    if (th.getAttribute("data-col-no-resize") === "true") fixedW[colIds[i]] = true;
  });
  // A column the operator can drag — excludes both utility (noResize) and
  // static-width (fixedW) columns.
  function isResizableCol(id) { return !noResize[id] && !fixedW[id]; }

  // Inject a colgroup so widths apply consistently to header + body.
  var colgroup = tableEl.querySelector("colgroup");
  if (!colgroup) {
    colgroup = document.createElement("colgroup");
    ths.forEach(function () { colgroup.appendChild(document.createElement("col")); });
    tableEl.insertBefore(colgroup, thead);
  } else {
    while (colgroup.children.length < ths.length) colgroup.appendChild(document.createElement("col"));
  }
  var cols = Array.prototype.slice.call(colgroup.children).slice(0, ths.length);

  var srcIdxOf = {};
  colIds.forEach(function (id, i) { srcIdxOf[id] = i; });

  // ─── Column order ─────────────────────────────────────────────────────────
  // `order` is the operator's sequence for the MOVABLE columns — exactly the
  // set the chooser lists (everything not marked required / utility). Required
  // columns are anchors: they keep their authored index and the movable columns
  // fill the slots between them, so a leading checkbox column or a trailing
  // Actions column can't be dragged out of place.
  //
  // Storing a permutation of only the movable subset (rather than absolute
  // indexes) is what lets a saved order survive a Polaris update that adds a
  // column: normalizeOrder splices the newcomer back in next to its authored
  // neighbour instead of stranding it at the end.
  var movableSrc = colIds.filter(function (id) { return !required[id]; });
  var order = movableSrc.slice();

  // Prototype-less lookups: `saved` is untrusted — it comes back from
  // localStorage, or (for the Assets view tabs) from the server blob. A plain
  // {} inherits Object.prototype, so "constructor" / "toString" / "valueOf"
  // would read as KNOWN columns and get spliced into `order`, where they map to
  // no <th> and make placeInOrder bail — a table that silently stops honoring
  // its saved arrangement. Object.create(null) makes an unknown id unknown.
  function normalizeOrder(saved) {
    var known = Object.create(null);
    movableSrc.forEach(function (id) { known[id] = true; });
    var seen = Object.create(null);
    var out = [];
    (saved || []).forEach(function (id) {
      if (!known[id] || seen[id]) return;
      seen[id] = true;
      out.push(id);
    });
    // Columns missing from the saved order (added since it was written) land
    // immediately after their nearest preceding authored sibling.
    movableSrc.forEach(function (id, idx) {
      if (seen[id]) return;
      var pos = out.length;
      for (var k = idx - 1; k >= 0; k--) {
        var p = out.indexOf(movableSrc[k]);
        if (p >= 0) { pos = p + 1; break; }
      }
      out.splice(pos, 0, id);
    });
    return out;
  }

  function isDefaultOrder() {
    return order.every(function (id, i) { return movableSrc[i] === id; });
  }

  /** Column ids in DISPLAY order: required anchors at their authored index. */
  function displayIds() {
    var out = [];
    var mi = 0;
    for (var i = 0; i < colIds.length; i++) {
      if (required[colIds[i]]) out.push(colIds[i]);
      else out.push(order[mi++]);
    }
    return out;
  }

  /**
   * Move `els` (already in the desired order) into place under `parent`.
   * All-or-nothing: a gap in `els` means the caller's mapping doesn't describe
   * this parent, and a half-applied move is worse than none. Returns whether
   * it ran.
   */
  function placeInOrder(parent, els) {
    for (var g = 0; g < els.length; g++) if (!els[g]) return false;
    for (var i = 0; i < els.length; i++) {
      if (parent.children[i] !== els[i]) parent.insertBefore(els[i], parent.children[i] || null);
    }
    return true;
  }

  /** This table's own <tbody> elements (never a nested table's). */
  function ownBodies() {
    return Array.prototype.filter.call(tableEl.children, function (el) {
      return el.tagName === "TBODY";
    });
  }

  // The order each row's cells are CURRENTLY in. A row the page just rendered
  // is absent from the map and therefore in authored order; a row this helper
  // has already touched is in whatever order it left it. Reading the previous
  // order back is what makes a second reorder (or a reset) correct — mapping a
  // dragged row as though it were still authored-order scrambles it. WeakMap
  // rather than a data- attribute so re-rendered rows cost nothing and the
  // markup stays clean.
  var rowOrder = new WeakMap();

  function applyBodyOrder(disp) {
    var sig = disp.join(",");
    ownBodies().forEach(function (tb) {
      Array.prototype.forEach.call(tb.children, function (row) {
        if (row.tagName !== "TR") return;
        var prev = rowOrder.get(row);
        if (prev === sig) return;
        // Skip colspan / section-header rows: their cells don't map 1:1 onto
        // the column set (the interfaces table's group headers, empty states).
        if (row.children.length !== colIds.length) return;
        var curIdxOf = srcIdxOf;
        if (prev) {
          curIdxOf = {};
          prev.split(",").forEach(function (id, p) { curIdxOf[id] = p; });
        }
        var kids = Array.prototype.slice.call(row.children);
        if (placeInOrder(row, disp.map(function (id) { return kids[curIdxOf[id]]; }))) {
          rowOrder.set(row, sig);
        }
      });
    });
  }

  // Re-apply the order after the page re-renders its tbody. Only tbody
  // childList is observed, so our own cell moves (a mutation on the ROW) can't
  // re-trigger it. Installed lazily — a table left in authored order pays
  // nothing. Self-disconnects once the table is detached.
  var orderObserver = null;
  function ensureOrderObserver() {
    if (orderObserver || typeof MutationObserver !== "function") return;
    var bodies = ownBodies();
    if (!bodies.length) return;
    orderObserver = new MutationObserver(function () {
      if (!tableEl.isConnected) { orderObserver.disconnect(); orderObserver = null; return; }
      if (isDefaultOrder()) return;
      applyBodyOrder(displayIds());
    });
    bodies.forEach(function (tb) { orderObserver.observe(tb, { childList: true }); });
  }

  function applyColumnOrder() {
    var disp = displayIds();
    placeInOrder(headerRow, disp.map(function (id) { return ths[srcIdxOf[id]]; }));
    placeInOrder(colgroup, disp.map(function (id) { return cols[srcIdxOf[id]]; }));
    applyBodyOrder(disp);
    if (!isDefaultOrder()) ensureOrderObserver();
  }

  // Per-table <style> block holding hide rules. Targeted by data-sf-table-id
  // so multiple tables on the same page don't collide.
  var tableId = tableEl.getAttribute("data-sf-table-id");
  if (!tableId) {
    tableId = "sftbl-" + Math.random().toString(36).slice(2, 9);
    tableEl.setAttribute("data-sf-table-id", tableId);
  }
  var styleEl = document.getElementById("sf-style-" + tableId);
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.id = "sf-style-" + tableId;
    document.head.appendChild(styleEl);
  }

  // Utility-column track (checkbox / favourite star). 34, not 20: a ~16px box
  // in a 20px track has 2px either side, and the gap on its right also carries
  // the next cell's padding — so it read as left-hugging. 34 leaves even air
  // and still costs less than a data column.
  var FIXED_COL_W = 34;
  // Floor under EVERY width this helper writes. A column may be squeezed to a
  // 5px sliver — enough to see it's still there, and enough to grab its own
  // resize handle and pull it back out — but never to 0px, which reads as "the
  // column is gone" and leaves the operator nothing to drag. Deliberately far
  // below anything readable: the point is existence, not legibility, so an
  // operator packing many columns into one screen can park the ones they don't
  // need at a sliver instead of hiding them outright.
  var MIN_COL_W = 5;
  // Below this a column renders as mostly padding and its header label wraps a
  // letter per line, which stretches the whole thead. The auto-fill column is
  // floored here so a table that overflows scrolls horizontally instead of
  // ballooning its header height.
  var AUTOFILL_MIN_W = 36;
  var widths = {};
  var hidden = {};

  // Pin fixed utility columns to FIXED_COL_W up front so every applyWidths()
  // call honors them — otherwise, in table-layout:fixed, a column with no
  // width entry would absorb leftover space and balloon past its 20px floor.
  colIds.forEach(function (id, i) {
    if (!noResize[id]) return;
    var declared = parseFloat(ths[i].style.width);
    widths[id] = declared > 0 ? declared : FIXED_COL_W;
  });

  // Pin static-width columns to the width DECLARED on their <th>, not to a
  // measured render. These columns carry no drag handle, so a first render that
  // measured them crushed locks that width in permanently with no operator
  // recourse — and auto layout crushes readily: `overflow-wrap: anywhere` on
  // `thead th` makes a header's min-content one character, so an over-committed
  // table can squeeze a declared 120px column down to ~40px. The declared width
  // is the single source of truth (setPrefs ignores stale saved widths for them
  // the same way it does for the utility columns).
  ths.forEach(function (th, i) {
    if (!fixedW[colIds[i]]) return;
    var declaredW = parseFloat(th.style.width);
    if (declaredW > 0) widths[colIds[i]] = declaredW;
  });

  // Seed default-hidden columns. A <th data-col-default-hidden="true"> starts
  // hidden until the user enables it. Saved prefs override this via setPrefs:
  // a `shown` snapshot un-hides anything the user explicitly turned on, so the
  // default only applies to columns the user has never made a choice about
  // (notably newly added columns, absent from older saved prefs).
  ths.forEach(function (th, i) {
    if (!required[colIds[i]] && th.getAttribute("data-col-default-hidden") === "true") {
      hidden[colIds[i]] = true;
    }
  });

  // Below this a column is mostly padding: the 1rem horizontal cell padding on
  // each side plus borders is ~33px, and a table cell's border box can't render
  // narrower than its own padding — so a column dragged to the MIN_COL_W sliver
  // would stop dead around 33px with the floor looking broken. Those columns
  // get their padding dropped (below) so the width a column is given is the
  // width it renders at.
  var NARROW_COL_W = 36;

  // One generated stylesheet per table, carrying both position-dependent rules:
  // hidden columns, and padding-free narrow ones. nth-child indexes are DISPLAY
  // positions — a reordered table's cells sit at different offsets than their
  // authored ones. Written only on change: this runs on every resize-drag frame
  // (from applyWidths), and replacing a stylesheet's text invalidates style for
  // the whole table.
  function rewriteHideStyle() {
    var rules = [];
    var sel = 'table[data-sf-table-id="' + tableId + '"]';
    displayIds().forEach(function (id, pos) {
      var n = pos + 1;
      if (hidden[id]) {
        rules.push(sel + ' > thead > tr > :nth-child(' + n + ') { display: none; }');
        rules.push(sel + ' > tbody > tr > :nth-child(' + n + ') { display: none; }');
        rules.push(sel + ' > colgroup > col:nth-child(' + n + ') { display: none; }');
        return;
      }
      // Utility columns (cb/fav) already carry their own tight padding.
      if (noResize[id]) return;
      // The rendered width, not the stored base: the fit pass stretches
      // columns, and it owns the auto-fill column's width outright.
      var w = parseFloat(cols[srcIdxOf[id]].style.width) || 0;
      // `>` not `>=`: a column sitting exactly ON the threshold is the worst
      // case — too narrow to hold its label, but not stripped of the padding
      // that is squeezing it. It gets the strip.
      if (!w || w > NARROW_COL_W) return;
      rules.push(sel + ' > thead > tr > :nth-child(' + n + '),');
      // overflow:hidden as well: a header's filter control and a cell's button
      // group have their own intrinsic widths, and at a sliver they'd paint
      // over the neighboring column instead of being clipped by it.
      rules.push(sel + ' > tbody > tr > :nth-child(' + n + ') { padding-left: 1px; padding-right: 1px; overflow: hidden; }');
    });
    var text = rules.join("\n");
    if (styleEl.textContent !== text) styleEl.textContent = text;
  }

  // Source index of the rightmost visible, resizable (non-utility) column —
  // "rightmost" in DISPLAY order, so it follows a drag-reorder. This column is
  // deliberately left without an explicit width so it auto-fills the remaining
  // space — keeping its right edge pinned to the table border (no trailing
  // gap). It recomputes as columns are hidden/shown/reordered.
  function lastVisibleResizableIdx() {
    var disp = displayIds();
    for (var k = disp.length - 1; k >= 0; k--) {
      if (!hidden[disp[k]] && isResizableCol(disp[k])) return srcIdxOf[disp[k]];
    }
    return -1;
  }

  function applyWidths() {
    var lastIdx = lastVisibleResizableIdx();
    var anyWidth = false;
    colIds.forEach(function (id, i) {
      if (i === lastIdx) {
        // Auto-fill column: its width is owned by fitColumnsToContainer
        // (scheduled below), which computes it arithmetically. Never clear it
        // here — a transient un-sizing shrinks the table for one layout pass,
        // and when the table overflows horizontally that clamps the wrapper's
        // scrollLeft, yanking the view back left on every resize-drag frame.
      } else {
        var w = widths[id];
        if (typeof w === "number" && w > 0) {
          cols[i].style.width = Math.max(MIN_COL_W, w) + "px";
          anyWidth = true;
        } else {
          cols[i].style.width = "";
        }
      }
      // The auto-fill column's handle is inert (nothing to its right to push
      // into); hide it so the user can't drag the table's right edge off the
      // border. Every other resizable column keeps its handle.
      var handle = ths[i] && ths[i].querySelector(".sf-resize-handle");
      if (handle) handle.style.display = (i === lastIdx) ? "none" : "";
    });
    tableEl.style.tableLayout = anyWidth ? "fixed" : "";
    rewriteHideStyle();
    scheduleColumnFit();
  }

  // NOT a floor (that's MIN_COL_W) — the width handed to a column that was
  // never measurable, so it lands somewhere readable rather than at the sliver
  // an operator would have had to choose deliberately.
  var UNMEASURED_COL_W = 40;
  var fitScheduled = false;

  /**
   * A column's BASE width — the operator's dragged / seeded / declared width,
   * never a stretched render. The fit pass below writes stretched widths onto
   * the <col> elements, so reading those back as the input would make its own
   * arithmetic self-fulfilling (every pass would treat the last result as the
   * new base and the distribution would never converge on the same answer).
   */
  function baseWidthOf(i) {
    var w = widths[colIds[i]];
    if (typeof w === "number" && w > 0) return w;
    var spec = parseFloat(cols[i].style.width);
    if (spec > 0) return spec;
    return ths[i].getBoundingClientRect().width || 0;
  }

  function setColWidth(i, px) {
    // Write only on change so the ResizeObserver below doesn't re-fire on
    // every pass.
    var next = px + "px";
    if (cols[i].style.width !== next) cols[i].style.width = next;
  }

  // Sizes the visible columns so their sum is EXACTLY the container's content
  // width, leaving no trailing gap at the table's right border. When the base
  // widths sum narrower than the container, the leftover is distributed across
  // every resizable column in proportion to its base width — not dumped whole
  // onto the rightmost one, which is what left a narrow table (Users, Roles,
  // Group Mappings) with cramped columns and one enormous last column holding
  // all the blank space. Columns pinned to a declared width — utility (cb/fav)
  // and static-width (`data-col-no-resize`) — are the "honor the declared
  // width" tier and never stretch; they're subtracted from the budget first.
  //
  // Computed arithmetically — NEVER by clearing a width and measuring the
  // auto-fill result: a transient clear shrinks the table for one layout pass,
  // and when the table overflows horizontally that clamps the wrapper's
  // scrollLeft and yanks the view back left (the drag-while-scrolled bug).
  // Always writing explicit widths also covers both fixed-layout quirks in one
  // place:
  //  - colspan first <tbody> row (interfaces table's section header): an
  //    auto-width column has no per-column width basis, so fixed layout
  //    strands the leftover as a trailing gap instead of growing the column.
  //  - CRUSHED column: when the other visible columns already sum past the
  //    container, fixed layout gives an auto column ~0px — invisible, with
  //    its header content painting past the table border into overflow the
  //    wrapper's scrollbar can't reach. Rescue with the column's
  //    saved/measured width so the table grows and the scrollbar covers it.
  function fitColumnsToContainer() {
    var lastIdx = lastVisibleResizableIdx();
    if (lastIdx < 0) return;
    var tableRect = tableEl.getBoundingClientRect();
    if (!tableRect.width) return;                   // off-screen; nothing to measure
    // What table width:100% resolves against: the parent's content box.
    var availW = tableRect.width;
    var parent = tableEl.parentElement;
    if (parent) {
      var pcs = getComputedStyle(parent);
      availW = parent.clientWidth - (parseFloat(pcs.paddingLeft) || 0) - (parseFloat(pcs.paddingRight) || 0);
    }
    // Walked in DISPLAY order so the rounding residual lands on the column the
    // operator actually sees last (== lastIdx, by construction).
    var flex = [], flexSum = 0, fixedSum = 0;
    displayIds().forEach(function (id) {
      if (hidden[id]) return;
      var i = srcIdxOf[id];
      var w = baseWidthOf(i);
      if (isResizableCol(id)) { flex.push(i); flexSum += w; }
      else fixedSum += w;
    });
    if (!flex.length) return;
    var budget = Math.floor(availW - fixedSum);     // px the resizable columns share

    if (flexSum > 0 && budget - flexSum >= 1) {
      // Slack to spread: scale every resizable column up proportionally.
      var scale = budget / flexSum;
      var assigned = 0;
      for (var k = 0; k < flex.length - 1; k++) {
        var base = baseWidthOf(flex[k]);
        // A zero base means the column was never measurable (nothing seeded,
        // nothing saved) — scaling it keeps it at 0px, i.e. invisible. Give it
        // a readable default instead; the last column absorbs the difference.
        var w = base > 0 ? Math.floor(base * scale) : UNMEASURED_COL_W;
        setColWidth(flex[k], w);
        assigned += w;
      }
      setColWidth(flex[flex.length - 1], Math.max(MIN_COL_W, budget - assigned));
      rewriteHideStyle();
      return;
    }

    // Exactly filled or over-committed: base widths stand and the last column
    // takes what's left. Rewritten rather than left alone because this pass
    // also runs on its own from the ResizeObserver — a container SHRINK has to
    // roll back the stretched widths an earlier pass wrote.
    var others = 0;
    flex.forEach(function (i) {
      if (i === lastIdx) return;
      var bw = baseWidthOf(i);
      // Written raw, not rounded, so the string matches what `applyWidths` puts
      // on the same <col> — otherwise the two passes would trade 137.5px for
      // 138px on every render.
      setColWidth(i, bw);
      others += bw;
    });
    var target = Math.floor(availW - fixedSum - others);
    if (target < MIN_COL_W) {
      // Crushed: no leftover to fill. Use the column's saved/measured width
      // (MIN_COL_W floor) instead of letting it collapse.
      var savedW = widths[colIds[lastIdx]];
      target = Math.max(MIN_COL_W, (typeof savedW === "number" && savedW > 0) ? savedW : 0);
    }
    // Never starve the auto-fill column: it absorbs every deficit, and once it
    // is narrower than its label's min-content the header wraps a letter per
    // line and stretches the whole thead. A width declared on the th is an
    // explicit statement of how much the column needs, so it wins; otherwise
    // fall back to AUTOFILL_MIN_W. Overflow goes to the wrapper's horizontal
    // scroll, which is recoverable — a 124px-tall header is not.
    //
    // LAST, after the crushed-table fallback above and not before it: floored
    // first, `target` can never be below MIN_COL_W, so that branch would be
    // dead code and an over-committed table would hand the auto-fill column
    // 36px instead of the saved width it is supposed to keep.
    var declaredLast = parseFloat(ths[lastIdx].style.width) || 0;
    target = Math.max(target, AUTOFILL_MIN_W, declaredLast);
    setColWidth(lastIdx, target);
    rewriteHideStyle();
  }
  function scheduleColumnFit() {
    if (typeof requestAnimationFrame !== "function") { fitColumnsToContainer(); return; }
    if (fitScheduled) return;
    fitScheduled = true;
    requestAnimationFrame(function () { fitScheduled = false; fitColumnsToContainer(); });
  }

  /**
   * Fold the widths the fit pass stretched back into `widths`, so they become
   * the base for what follows. Called at the start of a resize drag: the stored
   * base can sum narrower than the container, and a drag that moved a base
   * pixel would then move the divider by more than one screen pixel. After
   * committing, the base sums to the container width, so the drag tracks the
   * pointer 1:1 and creates no new slack for the fit pass to redistribute —
   * an operator narrowing a column widens its neighbour, never everything.
   */
  function commitStretchedWidths() {
    colIds.forEach(function (id, i) {
      if (hidden[id] || !isResizableCol(id)) return;
      var spec = parseFloat(cols[i].style.width);
      if (spec > 0) widths[id] = Math.round(spec);
    });
  }

  function ensureAllWidthsMeasured() {
    // Capture rendered widths on first resize so switching to fixed layout
    // doesn't collapse the columns the user hasn't touched yet.
    colIds.forEach(function (id, i) {
      if (widths[id] != null) return;
      var rect = ths[i].getBoundingClientRect();
      if (rect.width > 0) widths[id] = Math.round(rect.width);
    });
  }

  ths.forEach(function (th, i) {
    if (!isResizableCol(colIds[i])) return;        // utility + static-width columns get no handle
    if (th.querySelector(".sf-resize-handle")) return;
    // Only force a positioning context when the th has none. Setting inline
    // position:relative on a th whose stylesheet says position:sticky would
    // kill the sticky header (ip-panel); sticky is itself a containing block
    // for the absolute resize handle, so it needs no override.
    if (getComputedStyle(th).position === "static") th.style.position = "relative";
    var handle = document.createElement("span");
    handle.className = "sf-resize-handle";
    handle.title = "Drag to resize";
    th.appendChild(handle);
    handle.addEventListener("click", function (e) { e.stopPropagation(); });
    handle.addEventListener("mousedown", function (e) {
      e.preventDefault();
      e.stopPropagation();
      // The rightmost visible column auto-fills to keep the table's right edge
      // on the border, so its handle does nothing — bail before starting a drag.
      if (i === lastVisibleResizableIdx()) return;
      ensureAllWidthsMeasured();
      commitStretchedWidths();   // drag against what's on screen, 1:1
      var id = colIds[i];
      var startX = e.clientX;
      var startW = widths[id] || ths[i].getBoundingClientRect().width;
      // Divider behavior: a drag only affects the column on each side of the
      // handle. Find the next visible, resizable column to the right — the
      // "right neighbor" we trade width with (skip hidden / fixed columns).
      // Walked in DISPLAY order so a reordered table trades with the column
      // the operator actually sees to the right of the handle.
      var lastIdx = lastVisibleResizableIdx();
      var dispNow = displayIds();
      var nIdx = -1;
      for (var nk = dispNow.indexOf(id) + 1; nk > 0 && nk < dispNow.length; nk++) {
        if (!hidden[dispNow[nk]] && isResizableCol(dispNow[nk])) { nIdx = srcIdxOf[dispNow[nk]]; break; }
      }
      // When the right neighbor is the auto-fill (last) column it has no fixed
      // width — let it absorb the delta naturally (only this column + the
      // auto-fill column change). Otherwise trade width 1:1 with the neighbor
      // so every other column stays put.
      var nId = (nIdx >= 0 && nIdx !== lastIdx) ? colIds[nIdx] : null;
      var startWNext = nId ? (widths[nId] || ths[nIdx].getBoundingClientRect().width) : null;
      function onMove(ev) {
        var dx = ev.clientX - startX;
        if (startWNext != null) {
          // Clamp so neither the dragged column nor its neighbor goes below MIN_COL_W.
          var d = Math.max(-(startW - MIN_COL_W), Math.min(startWNext - MIN_COL_W, dx));
          widths[id] = Math.round(startW + d);
          widths[nId] = Math.round(startWNext - d);
        } else {
          widths[id] = Math.max(MIN_COL_W, Math.round(startW + dx));
        }
        applyWidths();
      }
      function onUp() {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.classList.remove("sf-resizing");
        if (typeof options.onChange === "function") options.onChange();
      }
      document.body.classList.add("sf-resizing");
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  });

  // Seed table-layout:fixed so cells can truncate (an ellipsis only renders
  // with a bounded column width). Measure each visible column's natural render
  // width and lock it in; the cb/fav utility columns are pinned to FIXED_COL_W.
  // Bail if any visible column measures 0 — that means the table was rendered
  // off-screen (inactive SPA section, getBoundingClientRect == 0); leaving it
  // in auto-layout avoids collapsing columns, and a later visible re-render (or
  // setPrefs restoring saved widths) seeds it then. Saved prefs still override
  // per-column afterward via setPrefs. cb/fav are already pinned to FIXED_COL_W.
  (function seedFixedLayout() {
    var measured = {};
    var visibleIds = colIds.filter(function (id) { return !hidden[id]; });
    var ok = visibleIds.every(function (id) {
      if (noResize[id]) return true; // already pinned to FIXED_COL_W
      var idx = colIds.indexOf(id);
      var w = ths[idx].getBoundingClientRect().width;
      if (w > 0) { measured[id] = Math.round(w); return true; }
      return false;
    });
    if (!ok) return;
    visibleIds.forEach(function (id) {
      if (widths[id] == null) widths[id] = measured[id];
    });
    applyWidths();
  })();

  // Re-fit the columns when the table becomes measurable (revealed from an
  // inactive tab) or the container resizes. The parent is observed too: with
  // every column pinned to an explicit width, a container SHRINK doesn't
  // change the table's own size (fixed layout keeps the column sum), so only
  // the parent resize reveals that the stretch has to be given back.
  // Self-disconnects once the table is detached (every re-render builds a
  // fresh table + observer), so observers don't accumulate across the
  // interface table's refresh ticks.
  if (typeof ResizeObserver === "function") {
    var columnFitRo = new ResizeObserver(function () {
      if (!tableEl.isConnected) { columnFitRo.disconnect(); return; }
      scheduleColumnFit();
    });
    columnFitRo.observe(tableEl);
    if (tableEl.parentElement) columnFitRo.observe(tableEl.parentElement);
  }

  // Floating gear pinned to the top-right CORNER of the table's scroll
  // wrapper. It used to live inside the rightmost visible <th>, which meant a
  // horizontally-overflowing table forced the operator to scroll right to
  // find it. It now sits in a zero-height position:relative anchor <div>
  // inserted immediately BEFORE the scroll wrapper — outside the overflow
  // container, so scrolling (horizontal, or the sticky wrapper's internal
  // vertical) never moves it. On .table-wrapper-sticky pages the header row
  // is sticky at the wrapper top, so the gear stays visually attached to the
  // header. Revealed on wrapper hover via JS (it's no longer a thead
  // descendant, so the old CSS :hover reveal can't reach it); a short hide
  // delay lets the pointer cross from the wrapper onto the gear (which is
  // painted on top of the wrapper, so entering it fires the wrapper's
  // mouseleave first).
  var gearWrap = null;
  // The anchor host: the direct-parent scroll container when there is one
  // (every list page + asset-detail table wraps its <table> in a
  // .table-wrapper with overflow auto), else the table itself.
  var gearHost = (function () {
    var p = tableEl.parentElement;
    if (p && p !== document.body && /(auto|scroll)/.test(getComputedStyle(p).overflowX)) return p;
    return tableEl;
  })();
  // Idempotency across re-setups (applyTableLayout re-runs after every
  // render): an anchor stamped with this table's id and still holding a gear
  // means the same table DOM was set up before — keep the existing gear and
  // its listeners. A stale anchor from a replaced table render is emptied and
  // reclaimed.
  var gearAnchor = (function () {
    var prev = gearHost.previousElementSibling;
    return (prev && prev.classList && prev.classList.contains("sf-col-gear-anchor")) ? prev : null;
  })();
  if (ths.length > 0 && gearAnchor && gearAnchor.getAttribute("data-sf-for") === tableId &&
      gearAnchor.querySelector(".sf-col-gear-wrap")) {
    gearWrap = gearAnchor.querySelector(".sf-col-gear-wrap");
  } else if (ths.length > 0) {
    if (!gearAnchor) {
      gearAnchor = document.createElement("div");
      gearAnchor.className = "sf-col-gear-anchor";
      gearHost.parentNode.insertBefore(gearAnchor, gearHost);
    } else {
      gearAnchor.textContent = "";
    }
    gearAnchor.setAttribute("data-sf-for", tableId);
    // Fallback-host + sticky-header combo (ip-panel style: sticky ths inside
    // an ancestor scroller, no dedicated wrapper): make the anchor sticky at
    // the header's own offset so the gear rides with the pinned header
    // instead of scrolling away with the table top. Inert when nothing
    // scrolls; never applied when the host is a wrapper (there the scrolling
    // happens INSIDE the wrapper, below the anchor).
    if (gearHost === tableEl && getComputedStyle(ths[0]).position === "sticky") {
      gearAnchor.style.position = "sticky";
      gearAnchor.style.top = getComputedStyle(ths[0]).top;
    }
    gearWrap = document.createElement("span");
    gearWrap.className = "sf-col-gear-wrap";
    var gearBtn = document.createElement("button");
    gearBtn.type = "button";
    gearBtn.className = "sf-col-gear";
    gearBtn.title = "Show or hide columns";
    gearBtn.setAttribute("aria-label", "Show or hide columns");
    gearBtn.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" aria-hidden="true">' +
      '<circle cx="12" cy="12" r="3"/>' +
      '<path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>' +
      '</svg>';
    gearBtn.addEventListener("mousedown", function (e) { e.stopPropagation(); });
    gearBtn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      var willOpen = !chooserPop || chooserPop.hasAttribute("hidden");
      document.querySelectorAll(".sf-multi-popover").forEach(function (p) { p.setAttribute("hidden", ""); });
      document.querySelectorAll(".sf-col-gear-wrap.open").forEach(function (g) { g.classList.remove("open"); });
      if (willOpen) {
        openChooser(gearBtn);
        gearWrap.classList.add("open");
        if (!gearWrap._observed && chooserPop) {
          gearWrap._observed = true;
          new MutationObserver(function () {
            if (chooserPop.hasAttribute("hidden")) {
              gearWrap.classList.remove("open");
              gearWrap.classList.remove("sf-gear-visible");
            }
          }).observe(chooserPop, { attributes: true, attributeFilter: ["hidden"] });
        }
      }
    });
    // Optional per-table screenshot button, sits to the LEFT of the gear
    // inside the floating wrap. Wired only when the caller passes
    // options.onScreenshot (asset-detail tables); other tables get the
    // gear alone, unchanged.
    if (typeof options.onScreenshot === "function") {
      var shotBtn = document.createElement("button");
      shotBtn.type = "button";
      shotBtn.className = "sf-col-gear sf-col-shot";
      shotBtn.title = "Copy this table as an image";
      shotBtn.setAttribute("aria-label", "Copy this table as an image");
      shotBtn.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" aria-hidden="true">' +
        '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>' +
        '<circle cx="12" cy="13" r="4"/>' +
        '</svg>';
      shotBtn.addEventListener("mousedown", function (e) { e.stopPropagation(); });
      shotBtn.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        try { options.onScreenshot(tableEl); } catch (_) {}
      });
      gearWrap.appendChild(shotBtn);
    }
    gearWrap.appendChild(gearBtn);
    gearAnchor.appendChild(gearWrap);

    // Hover reveal + scrollbar-aware placement. The right inset accounts for
    // the wrapper's vertical scrollbar (offsetWidth − clientWidth = scrollbar
    // + borders) so the gear never floats on top of it; recomputed on every
    // reveal since the scrollbar comes and goes with content height.
    var gearHideTimer = null;
    function showGear() {
      if (gearHideTimer) { clearTimeout(gearHideTimer); gearHideTimer = null; }
      gearWrap.style.right = (gearHost.offsetWidth - gearHost.clientWidth + 6) + "px";
      gearWrap.classList.add("sf-gear-visible");
    }
    function scheduleHideGear() {
      if (gearHideTimer) clearTimeout(gearHideTimer);
      gearHideTimer = setTimeout(function () {
        gearHideTimer = null;
        if (!gearWrap.classList.contains("open")) gearWrap.classList.remove("sf-gear-visible");
      }, 120);
    }
    [gearHost, gearWrap].forEach(function (el) {
      el.addEventListener("mouseenter", showGear);
      el.addEventListener("mouseleave", scheduleHideGear);
    });
  }

  var chooserPop = null;
  function buildChooser() {
    if (chooserPop) return chooserPop;
    chooserPop = document.createElement("div");
    chooserPop.className = "sf-col-chooser sf-multi-popover";
    chooserPop.setAttribute("hidden", "");
    chooserPop.addEventListener("click", function (e) { e.stopPropagation(); });
    chooserPop.addEventListener("change", function (e) {
      if (!e.target || e.target.type !== "checkbox") return;
      var id = e.target.getAttribute("data-col-id");
      if (!id) return;
      if (e.target.checked) delete hidden[id];
      else hidden[id] = true;
      rewriteHideStyle();
      applyWidths();   // recompute which column auto-fills to the right edge
      if (typeof options.onChange === "function") options.onChange();
    });
    wireChooserReorder();
    document.body.appendChild(chooserPop);
    return chooserPop;
  }

  // ─── Chooser drag-to-reorder ──────────────────────────────────────────────
  // Same idiom as the automations condition builder: a grip carries
  // draggable="true", the row it lives in is what moves, and the hovered row
  // shows a before/after edge cue. Delegated on the popover because
  // renderChooser() rebuilds its innerHTML on every open.
  var dragColId = null;
  var dropCueRow = null;

  function clearDropCue() {
    if (!dropCueRow) return;
    dropCueRow.classList.remove("sf-drop-before", "sf-drop-after");
    dropCueRow = null;
  }

  function wireChooserReorder() {
    chooserPop.addEventListener("dragstart", function (e) {
      var grip = e.target && e.target.classList && e.target.classList.contains("sf-col-grip") ? e.target : null;
      if (!grip) { return; }
      var row = grip.closest(".sf-col-chooser-row");
      dragColId = row ? row.getAttribute("data-col-id") : null;
      if (!dragColId) return;
      row.classList.add("sf-col-dragging");
      try { e.dataTransfer.setData("text/plain", dragColId); e.dataTransfer.effectAllowed = "move"; } catch (_) {}
    });
    chooserPop.addEventListener("dragover", function (e) {
      if (!dragColId) return;
      var row = e.target.closest && e.target.closest(".sf-col-chooser-row");
      if (!row || row.getAttribute("data-col-id") === dragColId) return;
      e.preventDefault();
      try { e.dataTransfer.dropEffect = "move"; } catch (_) {}
      clearDropCue();
      var rect = row.getBoundingClientRect();
      row.classList.add(e.clientY - rect.top < rect.height / 2 ? "sf-drop-before" : "sf-drop-after");
      dropCueRow = row;
    });
    chooserPop.addEventListener("drop", function (e) {
      var row = dropCueRow;
      var before = !!(row && row.classList.contains("sf-drop-before"));
      var targetId = row ? row.getAttribute("data-col-id") : null;
      clearDropCue();
      if (!dragColId || !targetId || targetId === dragColId) { dragColId = null; return; }
      e.preventDefault();
      moveColumn(dragColId, targetId, before);
      dragColId = null;
    });
    chooserPop.addEventListener("dragend", function () {
      clearDropCue();
      dragColId = null;
      var lifted = chooserPop.querySelector(".sf-col-dragging");
      if (lifted) lifted.classList.remove("sf-col-dragging");
    });
    // A grip inside the <label> would otherwise toggle that column's checkbox.
    chooserPop.addEventListener("click", function (e) {
      if (e.target && e.target.classList && e.target.classList.contains("sf-col-grip")) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      var reset = e.target && e.target.closest && e.target.closest(".sf-col-chooser-reset");
      if (!reset) return;
      e.preventDefault();
      order = movableSrc.slice();
      commitOrder();
    });
  }

  function moveColumn(fromId, toId, before) {
    var next = order.filter(function (id) { return id !== fromId; });
    var at = next.indexOf(toId);
    if (at < 0) return;
    next.splice(before ? at : at + 1, 0, fromId);
    order = next;
    commitOrder();
  }

  function commitOrder() {
    applyColumnOrder();
    rewriteHideStyle();   // nth-child hide rules are display-position based
    applyWidths();        // the auto-fill column may have changed
    renderChooser();
    if (typeof options.onChange === "function") options.onChange();
  }

  function renderChooser() {
    buildChooser();
    var html = '<div class="sf-col-chooser-title">Show columns</div>' +
      '<div class="sf-col-chooser-hint">Drag ⠿ to reorder</div>';
    var any = false;
    displayIds().forEach(function (id) {
      if (required[id]) return;
      any = true;
      var th = ths[srcIdxOf[id]];
      var label = (typeof options.labelFor === "function" ? options.labelFor(th) : null);
      if (!label) {
        var labelEl = th.querySelector(".sf-label");
        label = labelEl ? labelEl.textContent.trim() : th.textContent.trim();
      }
      if (!label) label = id;
      var checked = hidden[id] ? "" : "checked";
      html += '<label class="sf-col-chooser-row sf-multi-option" data-col-id="' + escapeHtml(id) + '">' +
        '<span class="sf-col-grip" draggable="true" title="Drag to reorder" aria-hidden="true">⠿</span>' +
        '<input type="checkbox" data-col-id="' + escapeHtml(id) + '" ' + checked + '>' +
        '<span class="sf-col-chooser-label">' + escapeHtml(label) + '</span></label>';
    });
    if (!any) html += '<div class="sf-col-chooser-empty">No optional columns.</div>';
    if (any && !isDefaultOrder()) {
      html += '<button type="button" class="sf-col-chooser-reset">Reset column order</button>';
    }
    chooserPop.innerHTML = html;
  }

  function openChooser(triggerEl) {
    renderChooser();
    document.querySelectorAll(".sf-multi-popover").forEach(function (p) { p.setAttribute("hidden", ""); });
    chooserPop.removeAttribute("hidden");
    var anchor = triggerEl || options.chooserButton || tableEl;
    chooserPop._sfAnchor = anchor;   // scroll-close containment test
    var r = anchor.getBoundingClientRect();
    chooserPop.style.position = "fixed";
    chooserPop.style.top  = (r.bottom + 4) + "px";
    chooserPop.style.left = Math.max(8, r.right - 240) + "px";
    chooserPop.style.minWidth = "220px";
  }

  if (options.chooserButton) {
    options.chooserButton.addEventListener("click", function (e) {
      e.stopPropagation();
      var willOpen = !chooserPop || chooserPop.hasAttribute("hidden");
      document.querySelectorAll(".sf-multi-popover").forEach(function (p) { p.setAttribute("hidden", ""); });
      if (willOpen) openChooser(options.chooserButton);
    });
  }

  // Reuse the doc-wide popover-close wiring TableSF._setup installs. If no
  // TableSF has been instantiated on the page (e.g. Events), install it here.
  TableSF._wireDocClose();

  return {
    getPrefs: function () {
      // Persist an explicit `shown` snapshot alongside `hidden` so a user's
      // "I turned this on" decision survives reloads even for columns that
      // default to hidden.
      var shown = colIds.filter(function (id) { return !required[id] && !hidden[id]; });
      return {
        widths: Object.assign({}, widths),
        hidden: Object.keys(hidden),
        shown: shown,
        order: order.slice(),
      };
    },
    setPrefs: function (p) {
      if (!p) return;
      if (Array.isArray(p.order)) order = normalizeOrder(p.order);
      if (p.widths && typeof p.widths === "object") {
        Object.keys(p.widths).forEach(function (id) {
          // Utility + static-width columns stay at their pinned/declared width;
          // ignore stale saved widths (they have no handle, so any saved value
          // is a measurement artifact — see the fixedW seed above).
          if (noResize[id] || fixedW[id]) return;
          var v = p.widths[id];
          if (typeof v === "number" && v > 0) widths[id] = Math.max(MIN_COL_W, v);
        });
      }
      // Apply `shown` (un-hide) before `hidden` (hide). `hidden` is pre-seeded
      // with default-hidden columns; un-hiding here lets a saved choice override
      // the default. Older prefs lack `shown`, so default-hidden columns stay
      // hidden and previously-hidden columns are still honored.
      if (Array.isArray(p.shown)) {
        p.shown.forEach(function (id) { delete hidden[id]; });
      }
      if (Array.isArray(p.hidden)) {
        p.hidden.forEach(function (id) {
          if (!required[id]) hidden[id] = true;
        });
      }
      applyColumnOrder();
      applyWidths();
      rewriteHideStyle();
    },
    openChooser: openChooser,
    refresh: function () { applyColumnOrder(); applyWidths(); rewriteHideStyle(); },
  };
}

/**
 * applyTableLayout(tableEl, typeKey, options?) — per-table-type wrapper around
 * setupColumnLayout for tables that are rebuilt on every render. Persists
 * widths + hidden cols + column order under
 * `polaris-table-layout-<typeKey>-<username>` so
 * the same Interface table widths apply to every asset and survive each
 * re-render. Safe to call after every innerHTML replacement; idempotent on
 * the same DOM since setupColumnLayout's chooser/resize handles are guarded
 * against duplicate install.
 */
function applyTableLayout(tableEl, typeKey, options) {
  if (!tableEl || !typeKey || typeof setupColumnLayout !== "function") return null;
  options = options || {};
  var user = (typeof currentUsername === "string" && currentUsername) ? currentUsername : "default";
  var storageKey = "polaris-table-layout-" + typeKey + "-" + user;
  var layout = setupColumnLayout(tableEl, {
    labelFor: options.labelFor,
    onScreenshot: options.onScreenshot,
    onChange: function () {
      try { localStorage.setItem(storageKey, JSON.stringify(layout.getPrefs())); } catch (_) {}
      if (typeof options.onChange === "function") options.onChange();
    },
  });
  if (!layout) return null;
  try {
    var raw = localStorage.getItem(storageKey);
    if (raw) layout.setPrefs(JSON.parse(raw));
  } catch (_) {}
  return layout;
}

// ─── Shared prefs round-trip (2026-08 audit) ────────────────────────────────
//
// Every list page persisted the same TableSF sort/filter state + a per-user
// "polaris-prefs-<page>-<username>" JSON round-trip with hand-rolled copies.
// The sort/filter half lives on TableSF; the storage half is PolarisPrefs.
// Pages keep their own extra keys (pageSize, layout(s)) in the same blob.

/** The persistable sort/filter state — spread into the page's prefs blob. */
TableSF.prototype.getPrefs = function () {
  return {
    sortKey: this._sortKey,
    sortDir: this._sortDir,
    sfFilters: Object.assign({}, this._filters),
  };
};

/**
 * Apply a stored prefs blob's sort/filter state. Accepts both the standard
 * shape (sortKey/sortDir/sfFilters) and events.js's legacy stored shape
 * (sort:{key,dir} / filters) so pre-existing saved prefs keep restoring.
 */
TableSF.prototype.setPrefs = function (p) {
  if (!p || typeof p !== "object") return;
  var sortKey = p.sortKey || (p.sort && p.sort.key);
  var sortDir = p.sortDir || (p.sort && p.sort.dir);
  if (sortKey) this._sortKey = sortKey;
  if (sortDir === "asc" || sortDir === "desc") this._sortDir = sortDir;
  var filters = p.sfFilters || p.filters;
  if (filters && typeof filters === "object") {
    this._filters = filters;
    this.restoreFilterUI();
  }
  this._updateIcons();
};

/**
 * Does this table have a header for `key`? Compares each th's attribute VALUE
 * rather than interpolating the key into a selector string: a sortKey arrives
 * from a stored preset (and a public preset is authored by another operator),
 * so it is arbitrary text. Escaping only the double quote left the backslash
 * live — `foo\` produced `[data-sf-key="foo\"]`, whose trailing escape swallows
 * the closing quote and lets the rest of the key be read as selector syntax.
 * There is nothing to escape if no selector is built.
 */
TableSF.prototype._hasSortableColumn = function (key) {
  var ths = this._thead ? this._thead.querySelectorAll("th[data-sf-key]") : [];
  for (var i = 0; i < ths.length; i++) {
    if (ths[i].getAttribute("data-sf-key") === key) return true;
  }
  return false;
};

/**
 * Replace the live sort + filter state WHOLESALE — the saved-filter-preset
 * counterpart of setPrefs. The difference matters: setPrefs merges (an absent
 * sortKey keeps whatever the operator had), while loading a preset must land
 * on exactly what was saved, so absent members here CLEAR. The state shape is
 * getPrefs()'s, which is also what the server stores.
 */
TableSF.prototype.applyState = function (state) {
  state = state || {};
  var filters = (state.sfFilters && typeof state.sfFilters === "object" && !Array.isArray(state.sfFilters))
    ? state.sfFilters : {};
  // Deep copy so the caller's cached preset isn't mutated by later edits to
  // the live filters (restoreFilterUI deletes shape-mismatched entries).
  this._filters = JSON.parse(JSON.stringify(filters));
  // Drop a sort key this table no longer has a header for — a preset saved
  // before a column was removed would otherwise keep sorting by it, and
  // server-side tables reject an unknown sortBy with a 400 on every load.
  var sortKey = state.sortKey || null;
  if (sortKey && this._thead && !this._hasSortableColumn(sortKey)) {
    sortKey = null;
  }
  this._sortKey = sortKey;
  this._sortDir = state.sortDir === "desc" ? "desc" : "asc";
  this.restoreFilterUI();
  this._updateIcons();
};

window.PolarisPrefs = {
  /** Persist a page's prefs blob under polaris-prefs-<page>-<username>. */
  save: function (page, username, obj) {
    if (!username) return;
    try {
      localStorage.setItem("polaris-prefs-" + page + "-" + username, JSON.stringify(obj));
    } catch (_) {}
  },
  /** Load a page's prefs blob; null when absent/unparseable/no user. */
  load: function (page, username) {
    if (!username) return null;
    var raw;
    try { raw = localStorage.getItem("polaris-prefs-" + page + "-" + username); } catch (_) { return null; }
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (_) { return null; }
  },
};
