/**
 * public/js/condition-builder.js — the nested AND/OR device-condition builder,
 * extracted from the automation wizard so contacts can use the same thing.
 *
 * Two exports on window.PolarisConditionBuilder:
 *
 *   wireDnD(panel, rootSelector, onChange, maxDepth)
 *     The grip drag-and-drop engine over .scr-row / .scg-group / .scg-children
 *     markup. Shared by BOTH tree builders in the wizard — the devices filter
 *     and the trigger's composite tree — which is why it's separate from
 *     create(): the trigger builder renders its own leaf rows and only wants
 *     the movement behaviour.
 *
 *   create({ meta, valueOptions, onChange })
 *     A builder instance for the scope-shaped tree: field/operator/value rows,
 *     nested groups, the click-to-suggest value combobox, and the DOM->tree
 *     collect. `meta` is the server's scopeCondition catalog (fields, ops,
 *     labels, maxDepth) and `valueOptions(field)` supplies the suggestions, so
 *     the module holds no catalog of its own and each caller injects its own.
 *
 * DOM order IS the tree — collect just walks it, so a drag needs no model
 * bookkeeping. The backend evaluates the same shape via evaluateScopeCondition.
 */
(function () {
  "use strict";

  function esc(s) {
    return typeof window.escapeHtml === "function"
      ? window.escapeHtml(s)
      : String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function toast(msg, kind) {
    if (typeof window.showToast === "function") window.showToast(msg, kind || "info");
  }

  // ── Condition-tree drag & drop ─────────────────────────────────────────
  // Grip handles (.aw-grip) start the drag (dashboard tab-grip pattern: the
  // dragged element is stashed module-side because dataTransfer is unreadable
  // during dragover); rows/groups accept before/after drops by cursor
  // midpoint, empty group bodies accept drop-into.
  var _dragEl = null;
  var _dropCue = null;
  function clearDropCue() {
    if (_dropCue) { _dropCue.classList.remove("aw-drop-before", "aw-drop-after", "aw-drop-into"); _dropCue = null; }
  }
  function groupDepthOf(el, rootEl) {
    var d = 0;
    var p = el.parentElement;
    while (p && p !== rootEl) {
      if (p.classList && p.classList.contains("scg-group")) d++;
      p = p.parentElement;
    }
    return d;
  }
  function subtreeHeight(el) {
    // How many group levels the dragged element itself adds (row = 0).
    if (!el.classList.contains("scg-group")) return 0;
    var max = 1;
    el.querySelectorAll(".scg-group").forEach(function (g) {
      var d = 1;
      var p = g.parentElement;
      while (p && p !== el) {
        if (p.classList.contains("scg-group")) d++;
        p = p.parentElement;
      }
      if (d + 1 > max) max = d + 1;
    });
    return max;
  }
  function fixDepths(rootEl) {
    var boundary = rootEl.parentElement || rootEl;
    rootEl.querySelectorAll(".scg-group").forEach(function (g) {
      var depth = groupDepthOf(g, boundary);
      g.setAttribute("data-depth", String(depth));
      g.style.borderLeftColor = depth === 0 ? "var(--color-accent)" : "var(--color-success)";
    });
  }
  function wireDnD(panel, rootSelector, onChange, maxDepth) {
    var cap = maxDepth || 5;
    panel.addEventListener("dragstart", function (e) {
      var grip = e.target && e.target.classList && e.target.classList.contains("aw-grip") ? e.target : null;
      if (!grip) return;
      var el = grip.closest(".scr-row, .scg-group");
      var root = panel.querySelector(rootSelector);
      if (!el || !root || !root.contains(el)) return;
      _dragEl = el;
      try { e.dataTransfer.setData("text/plain", ""); e.dataTransfer.effectAllowed = "move"; } catch (_e) {}
    });
    panel.addEventListener("dragover", function (e) {
      if (!_dragEl) return;
      var root = panel.querySelector(rootSelector);
      if (!root) return;
      var over = e.target.closest && e.target.closest(".scr-row, .scg-children, .scg-group");
      if (!over || !root.contains(over) || _dragEl.contains(over)) return;
      e.preventDefault();
      try { e.dataTransfer.dropEffect = "move"; } catch (_e) {}
      clearDropCue();
      if (over.classList.contains("scg-children")) {
        // Hovering a group's (possibly empty) body → drop into it.
        over.classList.add("aw-drop-into");
        _dropCue = over;
      } else {
        var rect = over.getBoundingClientRect();
        var before = e.clientY - rect.top < rect.height / 2;
        over.classList.add(before ? "aw-drop-before" : "aw-drop-after");
        _dropCue = over;
      }
    });
    panel.addEventListener("drop", function (e) {
      if (!_dragEl) return;
      var root = panel.querySelector(rootSelector);
      var cue = _dropCue;
      clearDropCue();
      if (!root || !cue || !root.contains(cue) || _dragEl.contains(cue)) { _dragEl = null; return; }
      e.preventDefault();
      var destChildren = null;
      var beforeEl = null;
      if (cue.classList.contains("scg-children")) {
        destChildren = cue;
      } else if (cue.classList.contains("scr-row")) {
        destChildren = cue.parentElement;
        beforeEl = e.clientY - cue.getBoundingClientRect().top < cue.getBoundingClientRect().height / 2 ? cue : cue.nextElementSibling;
      } else { // scg-group
        destChildren = cue.parentElement;
        if (!destChildren.classList.contains("scg-children")) { _dragEl = null; return; } // root group — can't sibling it
        beforeEl = e.clientY - cue.getBoundingClientRect().top < cue.getBoundingClientRect().height / 2 ? cue : cue.nextElementSibling;
      }
      // Depth cap (matches the render rule: child groups live at depth <=
      // maxDepth-1): destination group depth + the dragged subtree's height.
      var destGroup = destChildren.closest(".scg-group");
      var h = subtreeHeight(_dragEl); // rows = 0, plain group = 1, nested deeper
      if (h > 0 && groupDepthOf(destGroup, panel) + h > cap - 1) {
        toast("That move would nest groups more than " + cap + " levels deep", "info");
        _dragEl = null;
        return;
      }
      if (beforeEl) destChildren.insertBefore(_dragEl, beforeEl);
      else destChildren.appendChild(_dragEl);
      _dragEl = null;
      fixDepths(root);
      if (onChange) onChange();
    });
    panel.addEventListener("dragend", function () {
      _dragEl = null;
      clearDropCue();
    });
  }

  // ── Scope-shaped builder instance ──────────────────────────────────────
  function create(opts) {
    opts = opts || {};
    var meta = opts.meta || {};
    var valueOptionsFor = opts.valueOptions || function () { return []; };
    var onChange = opts.onChange || function () {};
    var maxDepth = meta.maxDepth || 5;
    var fields = meta.fields || [];

    function fieldMeta(field) {
      return fields.find(function (f) { return f.field === field; }) || fields[0];
    }
    function opOptions(field, sel) {
      var fm = fieldMeta(field);
      return ((fm && fm.ops) || []).map(function (o) {
        return '<option value="' + o + '"' + (o === sel ? " selected" : "") + '>' + esc((meta.operatorLabels || {})[o] || o) + '</option>';
      }).join("");
    }
    function groupOpOptions(sel) {
      return (meta.groupOps || []).map(function (o) {
        return '<option value="' + o + '"' + (o === sel ? " selected" : "") + '>' + esc((meta.groupOpLabels || {})[o] || o) + '</option>';
      }).join("");
    }
    function ruleRowHtml(rule) {
      rule = rule || { field: (fields[0] || {}).field || "assetType", operator: null, value: "" };
      var fm = fieldMeta(rule.field);
      var fieldOpts = fields.map(function (f) {
        return '<option value="' + f.field + '"' + (f.field === (fm && fm.field) ? " selected" : "") + '>' + esc(f.label) + '</option>';
      }).join("");
      return '<div class="scr-row" style="display:flex;gap:6px;align-items:center;margin:4px 0">' +
        '<span class="aw-grip" draggable="true" title="Drag to move">&#x2842;</span>' +
        '<select class="scr-field" style="width:31%">' + fieldOpts + '</select>' +
        '<select class="scr-op" style="width:26%">' + opOptions(fm && fm.field, rule.operator || (fm && fm.ops && fm.ops[0])) + '</select>' +
        '<span class="aw-combo">' +
          '<input type="text" class="scr-value" autocomplete="off" value="' + esc(rule.value || "") + '" placeholder="value">' +
          '<div class="aw-suggest"></div>' +
        '</span>' +
        '<button type="button" class="btn btn-sm btn-danger scr-remove" title="Remove condition">&times;</button>' +
      '</div>';
    }
    function groupHtml(group, depth) {
      group = group || { op: "and", children: [] };
      depth = depth || 0;
      var inner = (group.children || []).map(function (c) {
        return c && c.op !== undefined && Array.isArray(c.children)
          ? groupHtml(c, depth + 1)
          : ruleRowHtml(c);
      }).join("");
      return '<div class="scg-group" data-depth="' + depth + '" style="border:1px solid var(--color-border);border-left:3px solid ' + (depth === 0 ? "var(--color-accent)" : "var(--color-success)") + ';border-radius:6px;padding:0.55rem;margin:4px 0">' +
        '<div style="display:flex;gap:6px;align-items:center;margin-bottom:2px">' +
          (depth > 0 ? '<span class="aw-grip" draggable="true" title="Drag to move group">&#x2842;</span>' : "") +
          '<select class="scg-op" style="flex:1;font-size:0.85rem">' + groupOpOptions(group.op || "and") + '</select>' +
          (depth > 0 ? '<button type="button" class="btn btn-sm btn-danger scg-remove" title="Remove group">&times;</button>' : "") +
        '</div>' +
        '<div class="scg-children">' + inner + '</div>' +
        '<div style="margin-top:4px">' +
          '<button type="button" class="btn btn-sm btn-secondary scg-add-rule">+ Condition</button> ' +
          (depth + 1 < maxDepth ? '<button type="button" class="btn btn-sm btn-secondary scg-add-group">+ Group</button>' : "") +
        '</div>' +
      '</div>';
    }

    function openSuggest(input) {
      var row = input.closest(".scr-row");
      var suggest = input.parentElement.querySelector(".aw-suggest");
      if (!row || !suggest) return;
      var field = row.querySelector(".scr-field").value;
      var options = valueOptionsFor(field) || [];
      if (!options.length) { closeSuggest(suggest); return; }
      var q = input.value.trim().toLowerCase();
      var filtered = options.filter(function (o) {
        return !q || o.value.toLowerCase().indexOf(q) !== -1 || o.label.toLowerCase().indexOf(q) !== -1;
      }).slice(0, 50);
      suggest.innerHTML = filtered.length
        ? filtered.map(function (o) {
            return '<div class="aw-suggest-item" data-val="' + esc(o.value) + '" title="' + esc(o.label) + '">' + esc(o.label) + '</div>';
          }).join("")
        : '<div class="aw-suggest-empty">No matching values (free text is fine).</div>';
      suggest.classList.add("open");
    }

    /** Wire every interaction inside `panel` for the tree at `rootSelector`. */
    function wire(panel, rootSelector) {
      wireDnD(panel, rootSelector, onChange, maxDepth);

      panel.addEventListener("change", function (e) {
        var t = e.target;
        if (!t || !t.classList) return;
        if (t.classList.contains("scr-field")) {
          // Field changed: swap the operator list; the value combobox reads the
          // row's field at open time, so it just needs a reset.
          var row = t.closest(".scr-row");
          row.querySelector(".scr-op").innerHTML = opOptions(t.value, null);
          var input = row.querySelector(".scr-value");
          input.value = "";
          closeSuggest(row.querySelector(".aw-suggest"));
        }
        if (t.classList.contains("scr-field") || t.classList.contains("scr-op") || t.classList.contains("scg-op") || t.classList.contains("scr-value")) {
          onChange();
        }
      });
      panel.addEventListener("input", function (e) {
        if (e.target && e.target.classList && e.target.classList.contains("scr-value")) {
          openSuggest(e.target); // refilter the suggestions as they type
          onChange();
        }
      });
      panel.addEventListener("click", function (e) {
        var btn = e.target.closest && e.target.closest("button");
        if (!btn || !panel.contains(btn)) return;
        if (btn.classList.contains("scr-remove")) {
          btn.closest(".scr-row").remove();
          onChange();
        } else if (btn.classList.contains("scg-remove")) {
          btn.closest(".scg-group").remove();
          onChange();
        } else if (btn.classList.contains("scg-add-rule")) {
          var g1 = btn.closest(".scg-group");
          g1.querySelector(":scope > .scg-children").insertAdjacentHTML("beforeend", ruleRowHtml(null));
          onChange();
        } else if (btn.classList.contains("scg-add-group")) {
          var g2 = btn.closest(".scg-group");
          var depth = Number(g2.getAttribute("data-depth")) + 1;
          if (depth >= maxDepth) { toast("Groups nest at most " + maxDepth + " levels", "info"); return; }
          g2.querySelector(":scope > .scg-children").insertAdjacentHTML(
            "beforeend",
            groupHtml({ op: "or", children: [{ field: (fields[0] || {}).field, operator: ((fields[0] || {}).ops || [])[0], value: "" }] }, depth),
          );
          onChange();
        }
      });

      // Value combobox: focus/click opens existing values for the row's field;
      // typing filters (contains); ArrowUp/Down + Enter select; Esc closes.
      panel.addEventListener("focusin", function (e) {
        if (e.target && e.target.classList && e.target.classList.contains("scr-value")) openSuggest(e.target);
      });
      panel.addEventListener("click", function (e) {
        if (e.target && e.target.classList && e.target.classList.contains("scr-value")) openSuggest(e.target);
      });
      panel.addEventListener("focusout", function (e) {
        var input = e.target;
        if (!input || !input.classList || !input.classList.contains("scr-value")) return;
        // Delay so a mousedown on a suggestion (which fires before blur
        // completes) still lands.
        setTimeout(function () {
          var suggest = input.parentElement && input.parentElement.querySelector(".aw-suggest");
          if (suggest && !suggest.contains(document.activeElement)) closeSuggest(suggest);
        }, 150);
      });
      panel.addEventListener("mousedown", function (e) {
        var item = e.target.closest && e.target.closest(".aw-suggest-item");
        if (!item) return;
        e.preventDefault(); // keep focus on the input
        var combo = item.closest(".aw-combo");
        var input = combo.querySelector(".scr-value");
        input.value = item.getAttribute("data-val");
        closeSuggest(combo.querySelector(".aw-suggest"));
        onChange();
      });
      panel.addEventListener("keydown", function (e) {
        var input = e.target;
        if (!input || !input.classList || !input.classList.contains("scr-value")) return;
        var suggest = input.parentElement.querySelector(".aw-suggest");
        var open = suggest && suggest.classList.contains("open");
        if (e.key === "Escape") {
          if (open) { closeSuggest(suggest); e.stopPropagation(); } // keep the modal open
          return;
        }
        if (!open) return;
        var items = Array.from(suggest.querySelectorAll(".aw-suggest-item"));
        if (!items.length) return;
        var idx = items.findIndex(function (i) { return i.classList.contains("active"); });
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          var next = e.key === "ArrowDown" ? Math.min(idx + 1, items.length - 1) : Math.max(idx - 1, 0);
          items.forEach(function (i) { i.classList.remove("active"); });
          items[next].classList.add("active");
          if (items[next].scrollIntoView) items[next].scrollIntoView({ block: "nearest" });
        } else if (e.key === "Enter" && idx >= 0) {
          e.preventDefault();
          input.value = items[idx].getAttribute("data-val");
          closeSuggest(suggest);
          onChange();
        }
      });
    }

    /** DOM -> tree. `groupEl` is a .scg-group element. */
    function collect(groupEl) {
      var op = groupEl.querySelector(":scope > div > .scg-op").value;
      var children = [];
      groupEl.querySelectorAll(":scope > .scg-children > *").forEach(function (el) {
        if (el.classList.contains("scr-row")) {
          children.push({
            field: el.querySelector(".scr-field").value,
            operator: el.querySelector(".scr-op").value,
            value: el.querySelector(".scr-value").value.trim(),
          });
        } else if (el.classList.contains("scg-group")) {
          children.push(collect(el));
        }
      });
      return { op: op, children: children };
    }

    /** Tree -> first problem string, or null. Shared by every caller so the
     *  same empty group / empty value / bad CIDR is refused everywhere. */
    function validate(tree) {
      if (!tree) return null;
      var CIDR_ISH = /^([0-9]{1,3}\.){3}[0-9]{1,3}(\/[0-9]{1,2})?$|^[0-9a-f:]+(\/[0-9]{1,3})?$/i;
      var problem = null;
      var walk = function (g) {
        if (problem) return;
        if (!g.children.length) { problem = "A condition group is empty — add a condition or remove the group."; return; }
        g.children.forEach(function (c) {
          if (problem) return;
          if (c.op !== undefined && Array.isArray(c.children)) { walk(c); return; }
          if (!c.value) { problem = "Every condition needs a value (or remove the empty row)."; return; }
          // Both CIDR-valued fields — an IP block rule stores the block's own
          // CIDR, so it is refused here on the same terms the server refuses it.
          if ((c.field === "subnet" || c.field === "ipBlock") && !CIDR_ISH.test(c.value)) {
            problem = (c.field === "ipBlock" ? 'IP block "' : 'Subnet "') + c.value +
              '" does not look like a CIDR or IP (e.g. 10.20.0.0/16).';
          }
        });
      };
      walk(tree);
      return problem;
    }

    /** Seed a starter row into an empty root so a revealed builder is editable. */
    function seedIfEmpty(rootEl) {
      var kids = rootEl && rootEl.querySelector(":scope > .scg-group > .scg-children");
      if (kids && kids.children.length === 0) kids.insertAdjacentHTML("beforeend", ruleRowHtml(null));
    }

    return {
      meta: meta,
      maxDepth: maxDepth,
      ruleRowHtml: ruleRowHtml,
      groupHtml: groupHtml,
      wire: wire,
      collect: collect,
      validate: validate,
      seedIfEmpty: seedIfEmpty,
    };
  }

  /** Legacy flat scope/criteria -> a condition tree for editing (each used
   *  dimension becomes a rule, or an OR sub-group when it lists several). */
  function legacyScopeToCondition(sc) {
    sc = sc || {};
    var children = [];
    var addDim = function (list, field, operator) {
      if (!list || !list.length) return;
      var rules = list.map(function (v) { return { field: field, operator: operator, value: v }; });
      if (rules.length === 1) children.push(rules[0]);
      else children.push({ op: "or", children: rules });
    };
    addDim(sc.assetTypes, "assetType", "equals");
    addDim(sc.manufacturers, "manufacturer", "contains");
    addDim(sc.models, "model", "contains");
    addDim(sc.tags, "tag", "has");
    addDim(sc.subnetCidrs, "subnet", "inCidr");
    addDim(sc.assetIds, "assetId", "equals");
    return { op: "and", children: children };
  }

  /** Close a .aw-suggest dropdown. Generic enough that the wizard's OTHER
   *  combobox (the trigger step's dimension picker) shares it. */
  function closeSuggest(suggest) {
    if (suggest) { suggest.classList.remove("open"); suggest.innerHTML = ""; }
  }

  window.PolarisConditionBuilder = {
    create: create,
    wireDnD: wireDnD,
    fixDepths: fixDepths,
    closeSuggest: closeSuggest,
    legacyScopeToCondition: legacyScopeToCondition,
  };
})();
