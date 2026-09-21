/**
 * public/js/assets-discovery.js — the network Discovery wizard.
 *
 * Reached from the Assets page's "+ Add Asset(s)" menu. A **Discovery** is a
 * saved, re-runnable configuration that sweeps operator-supplied IP ranges,
 * identifies what answers, and lets the operator adopt chosen responders as
 * assets — the path for equipment that answers SNMP or a REST API but belongs
 * to no controller and no directory (PDUs, UPSes, sensors, cameras, older
 * switches), which otherwise has to be typed in one device at a time.
 *
 * Seven steps: Name → Targets → Methods → Run → Results → Monitoring →
 * Summary. Built in the idiom of appmap-rules-wizard.js: ONE closure-scoped
 * `draft`, a HTML/Wire/Collect/Validate quad per step behind COLLECT/VALIDATE
 * dispatch tables, a footer rendered once whose buttons are synced per step,
 * and free navigation back to any visited step. The shared .stepper /
 * .step-panel CSS is reused verbatim — the stepper must stay a DIRECT first
 * child of .modal-body for its sticky rule to apply. Ids are `nd-` prefixed.
 *
 * Three things differ from the other two wizards:
 *
 *   - **Steps 4–5 are a RUN, not authoring.** Step 4 saves the Discovery, POSTs
 *     a run and polls it; step 5 renders what came back. So the draft carries a
 *     `runId`, and re-entering step 4 REATTACHES to a scan already in flight
 *     rather than losing it when the operator closed the modal (the
 *     agent-build.js progress-strip precedent).
 *   - **Step 6 reuses the integrations page's auto-monitor selection builder**
 *     (`_autoMonitorInterfacesHTML` / `_readAutoMonitorInterfaces` /
 *     `_autoMonitorStorageHTML` / `_readAutoMonitorStorage`, module-level
 *     functions in integrations.js and therefore globals). That is deliberate:
 *     the selection VOCABULARY (byNames / byPatterns / byTypes / byLldp) is
 *     resolved server-side by one pair of pure resolvers, and a second render
 *     of it here is how the two surfaces would come to disagree about what a
 *     stored selection means. What this file supplies instead of that page's
 *     wire function is the DATA: the integrations version fills its checklists
 *     from `/integrations/:id/interface-aggregate` (assets that already exist
 *     and have been polled), while at scan time neither is true — so the names
 *     and types come from the inventory the scan itself collected. The row
 *     contract is a documented pair of selectors, not a private detail:
 *     `input[data-name-checkbox="1"][data-prefix=…]` for interfaces and
 *     `input[data-stor-name-checkbox="1"][data-prefix=…]` for mounts.
 *     (Moving those builders into a shared module is the better end state; it
 *     is a ~500-line move inside an 8k-line shared file and is deliberately not
 *     bundled with a feature commit.)
 *   - **Everything is gated by the key its own route checks.** Authoring and
 *     running are `networkScan`; ADOPTING is that plus `assets:write`, chained
 *     — so a read-level caller gets a read-only walkthrough, and a caller who
 *     may scan but not create sees Export/Save but no "Add selected".
 *
 * **Depends on globals** — load AFTER `api.js`, `app.js` (openModal /
 * closeModal / showToast / showConfirm / showRowMenu / escapeHtml / debounce /
 * permAtLeast), `integrations.js` (the auto-monitor builders above; a page
 * without it degrades step 6 to a plain message) and `assets.js` (which reads
 * this namespace lazily at click time, so this tag may come after it).
 */

/* global openModal, closeModal, showToast, showConfirm, escapeHtml, permAtLeast, showRowMenu, api,
          _autoMonitorInterfacesHTML, _readAutoMonitorInterfaces, _autoMonitorStorageHTML,
          _readAutoMonitorStorage, _amonTypeRowHTML */

(function () {
  "use strict";

  var STEPS = ["Name", "Targets", "Methods", "Run", "Results", "Monitor", "Summary"];

  /** Which credential type each method draws from. ICMP draws from none. */
  var METHOD_META = {
    icmp:    { label: "ICMP (ping)",  credType: null,      hint: "Liveness only — the cheap filter that keeps empty space from costing an authentication attempt per address." },
    snmp:    { label: "SNMP",         credType: "snmp",    hint: "The only method that can identify a device: hostname, vendor, and the interface + storage names step 6 pins by." },
    restapi: { label: "REST API",     credType: "restapi", hint: "For appliances with a token-authenticated API (a FortiGate, for instance)." },
    ssh:     { label: "SSH",          credType: "ssh",     hint: "Proves a login works. Interfaces only become visible once an agent runs." },
    winrm:   { label: "WinRM",        credType: "winrm",   hint: "Windows hosts. Interfaces only become visible once an agent runs." },
  };
  var METHOD_ORDER = ["icmp", "snmp", "restapi", "ssh", "winrm"];

  /** Terminal run statuses — the poller stops on these. */
  var TERMINAL = { completed: 1, aborted: 1, error: 1 };

  /** Poll cadence + giveup, the runScriptTest / agent-build.js shape. */
  var POLL_MS = 2000;
  var POLL_MAX_TRIES = 2700; // ~90 min; a /16 sweep is minutes, not hours

  // ─── Module-scope caches (read-only reference data) ────────────────────
  var _credentials = null;

  function emptyDraft() {
    return {
      id: null,
      name: "",
      description: null,
      // Private until its author shares it — the saved-filter / saved-dashboard
      // default. `isOwner` is true by construction on something not saved yet.
      visibility: "private",
      isOwner: true,
      createdBy: null,
      targets: [{ kind: "cidr", value: "" }],
      methods: [{ type: "icmp", credentialIds: [] }],
      autoMonitor: {},
      // Run state — never saved with the configuration.
      runId: null,
      hits: [],
      selected: [],
    };
  }

  /**
   * Every step leads with a question and one line of explanation, then the
   * controls — the automations wizard's shape (`<h3>` + tertiary `<p>`), so the
   * two builders read as one product rather than two.
   */
  function stepHead(question, explain) {
    return '<h3 style="margin:0 0 0.25rem">' + escapeHtml(question) + '</h3>' +
      '<p style="font-size:0.85rem;color:var(--color-text-tertiary);margin:0 0 1rem">' + explain + '</p>';
  }

  function canWrite() { return permAtLeast("networkScan", "write"); }

  /**
   * May the caller SAVE this draft? A new (or imported) Discovery is theirs by
   * construction; a saved one is theirs only if they own it, with fullwrite as
   * the housekeeping override — the same rule the route enforces. Mirrored here
   * so a shared Discovery someone else owns opens with no Save button rather
   * than with one that 403s.
   *
   * An ABSENT `isOwner` reads as yours — the server always sends it, so the
   * only way here without one is a payload this code didn't shape, and hiding
   * Save on a row that IS yours silently removes a capability where showing it
   * merely surfaces the route's own 403. `listRowItems` defaults the same way.
   */
  function canEditDraft(draft) {
    if (!canWrite()) return false;
    if (!draft || !draft.id) return true;
    return draft.isOwner !== false || permAtLeast("networkScan", "fullwrite");
  }
  function canAdopt() { return canWrite() && permAtLeast("assets", "write"); }
  function portability() { return window.PolarisDiscoveryPortability || null; }

  /** Credentials of one type, or [] when the list couldn't be loaded. */
  function credsOfType(type) {
    if (!Array.isArray(_credentials)) return [];
    return _credentials.filter(function (c) { return c && c.type === type; });
  }
  function credName(id) {
    var hit = (_credentials || []).find(function (c) { return c.id === id; });
    return hit ? hit.name : id;
  }

  /** Which auto-monitor group a hit belongs to. Mirrors methodKeyForHit. */
  function groupKeyForHit(hit) {
    if (!hit) return "unknown";
    if (hit.identifiedBy) return hit.identifiedBy;
    return (hit.respondedTo || []).indexOf("icmp") !== -1 ? "icmp" : "unknown";
  }

  /**
   * One line naming what a responder is, for the results + summary tables.
   *
   * A device whose vendor publishes a readable sysDescr format is named by its
   * parsed fields; everything else falls back to the raw description, which is
   * all there is. The fallback is deliberately not additive — an AXIS camera's
   * sysDescr already contains the model, type and firmware, so printing both
   * would say each of them twice in a cell an operator scans down a column of.
   */
  function hitIdentityLine(hit) {
    var id = hit.identity || {};
    var bits = [];
    if (id.manufacturer) bits.push(id.manufacturer);
    if (id.model || id.productType) {
      var named = [];
      if (id.model) named.push(id.model);
      if (id.productType) named.push(id.productType);
      bits.push(named.join(" "));
      if (id.osVersion) bits.push("fw " + id.osVersion);
    } else if (id.os) {
      bits.push(id.os);
    }
    return bits.join(" · ");
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  Open
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * `existing` is a saved Discovery (edit), absent for a new one.
   * `opts.import` marks a draft parsed out of a .discovery.json file, which
   * saves as a CREATE — the automations wizard's clone/import shape, where
   * `editing` deliberately stays null.
   */
  async function open(existing, opts) {
    opts = opts || {};
    var importing = !!opts.import && !!existing;
    var editing = importing ? null : (existing || null);

    var draft = existing ? JSON.parse(JSON.stringify(existing)) : emptyDraft();
    if (importing) draft.id = null;
    // Normalize a stored record into the draft shape (run state is not part of
    // what gets saved, so it is never present on a loaded row).
    if (!Array.isArray(draft.targets) || !draft.targets.length) draft.targets = [{ kind: "cidr", value: "" }];
    if (!Array.isArray(draft.methods) || !draft.methods.length) draft.methods = [{ type: "icmp", credentialIds: [] }];
    if (!draft.autoMonitor || typeof draft.autoMonitor !== "object") draft.autoMonitor = {};
    draft.runId = draft.runId || null;
    draft.hits = Array.isArray(draft.hits) ? draft.hits : [];
    draft.selected = Array.isArray(draft.selected) ? draft.selected : [];
    if (importing && opts.name) draft.name = opts.name;

    // Credentials back step 3's pickers. Deliberately not awaited-and-fatal: a
    // 403 on the credential list must degrade to "no credentials to pick",
    // never to a wizard that won't open.
    if (_credentials === null) {
      try {
        var resp = await api.credentials.list();
        _credentials = (resp && resp.credentials) || [];
      } catch (_) { _credentials = []; }
    }

    var step = 1;
    var visited = (editing || importing) ? STEPS.length : 1;
    var previewTimer = null;
    var pollTimer = null;
    var pollTries = 0;

    // ═════════════════════════════════════════════════════════════════════
    //  Step 1 — Name
    // ═════════════════════════════════════════════════════════════════════

    function step1Html() {
      var P = portability();
      var showImport = !editing && !importing && P && canWrite();
      // Inline button + explanation, the automations wizard's import row shape.
      var importRow = showImport
        ? '<div style="display:flex;align-items:center;gap:0.5rem;margin:0 0 1rem;flex-wrap:wrap">' +
            '<button type="button" class="btn btn-secondary" id="nd-import-btn">Import from file…</button>' +
            '<span style="font-size:0.8rem;color:var(--color-text-tertiary);flex:1 1 16rem">Start from an exported Discovery. ' +
              'Read in your browser — nothing is uploaded — and the file’s name becomes this Discovery’s name.</span>' +
            '<input type="file" id="nd-import-input" accept=".json,.discovery.json,application/json" style="display:none">' +
          '</div>'
        : "";
      return stepHead("What is this discovery?",
          'Name it and describe what it sweeps. A Discovery reports what <em>answers</em> — it creates nothing on ' +
          'its own, so you choose what to add on the Results step.') +
        (importing ? importNoteHtml() : "") +
        importRow +
        '<div class="form-group">' +
          '<label for="nd-name">Name</label>' +
          '<input type="text" id="nd-name" class="form-input" maxlength="200" placeholder="e.g. Ashfield management VLAN" value="' + escapeHtml(draft.name || "") + '">' +
        '</div>' +
        '<div class="form-group">' +
          '<label for="nd-desc">Description <span class="hint" style="margin:0">(optional)</span></label>' +
          '<textarea id="nd-desc" class="form-input" rows="2" maxlength="2000">' + escapeHtml(draft.description || "") + '</textarea>' +
        '</div>' +
        visibilityHtml();
    }

    /**
     * Who this Discovery is for. Private is the default — a half-built sweep of
     * somebody else's address space is not a thing to publish by accident — and
     * sharing is the whole reason the control exists: a Discovery one operator
     * spent an afternoon scoping is one every operator should be able to run.
     *
     * Rendered as a read-only line when the caller can't save this row, so a
     * shared Discovery states its own nature instead of offering a control that
     * would be refused.
     */
    function visibilityHtml() {
      var vis = draft.visibility === "public" ? "public" : "private";
      if (!canEditDraft(draft)) {
        return '<div class="form-group">' +
          '<label>Visibility</label>' +
          '<p class="hint" style="margin:0">' +
            (vis === "public" ? "Shared" : "Private") +
            (draft.createdBy ? " — created by " + escapeHtml(draft.createdBy) : "") +
            '. You can run it and add what answers; only its owner can change it.' +
          '</p></div>';
      }
      return '<div class="form-group">' +
        '<label for="nd-visibility">Who can use this discovery?</label>' +
        '<select id="nd-visibility" class="form-input">' +
          '<option value="private"' + (vis === "private" ? " selected" : "") + '>Private — only you</option>' +
          '<option value="public"' + (vis === "public" ? " selected" : "") + '>Shared — anyone who can run Discoveries</option>' +
        '</select>' +
        '<p class="hint" style="margin:0.35rem 0 0 0">Sharing lets other operators run it and adopt what answers. ' +
          'Editing and deleting stay yours.</p>' +
      '</div>';
    }

    function importNoteHtml() {
      var info = opts.importInfo || {};
      var deps = Array.isArray(info.dependencies) ? info.dependencies : [];
      var lines = deps.map(function (d) {
        var mark = d.present === true ? "✓" : d.present === false ? "✗ not in this install" : "? can't tell";
        return '<li>' + escapeHtml(d.kind + ": " + d.name) + ' — ' + escapeHtml(mark) + '</li>';
      });
      return '<div class="form-group" style="border:1px solid var(--color-warning);border-radius:var(--radius-sm);padding:0.6rem">' +
        '<p style="margin:0 0 0.35rem 0"><strong>Imported.</strong> Credentials are named, not carried — check step 3 before running.</p>' +
        (lines.length ? '<ul style="margin:0.25rem 0 0 1.1rem;font-size:0.85rem">' + lines.join("") + '</ul>' : "") +
        '</div>';
    }

    function wireStep1() {
      var btn = document.getElementById("nd-import-btn");
      var input = document.getElementById("nd-import-input");
      if (!btn || !input) return;
      btn.addEventListener("click", function () {
        input.value = ""; // picking the SAME file twice must still fire `change`
        input.click();
      });
      input.addEventListener("change", async function () {
        var file = this.files && this.files[0];
        input.value = "";
        if (!file) return;
        var P = portability();
        if (!P) return;
        if (file.size > P.MAX_IMPORT_BYTES) { showToast("That file is too large to be a Discovery.", "error"); return; }
        collectStep1();
        if (draft.name || (draft.targets || []).some(function (t) { return t.value; })) {
          if (!(await showConfirm("Replace what you have started with the imported Discovery?"))) return;
        }
        var parsed;
        try { parsed = P.parseImportFile(await file.text(), file.name); }
        catch (err) { showToast((err && err.message) || "That file could not be read as a Discovery.", "error"); return; }
        stopTimers();
        open(parsed.scan, { import: true, name: parsed.name, importInfo: { dependencies: parsed.dependencies } })
          .catch(function () {});
      });
    }

    function collectStep1() {
      var n = document.getElementById("nd-name");
      var d = document.getElementById("nd-desc");
      var v = document.getElementById("nd-visibility");
      if (n) draft.name = n.value.trim();
      if (d) draft.description = d.value.trim() || null;
      // Absent when the caller can't edit this row — leave the stored value be.
      if (v) draft.visibility = v.value === "public" ? "public" : "private";
    }

    function validateStep1() {
      if (!draft.name) return "Give the Discovery a name.";
      return null;
    }

    // ═════════════════════════════════════════════════════════════════════
    //  Step 2 — Targets
    // ═════════════════════════════════════════════════════════════════════

    function targetRowHtml(t, i) {
      var kinds = [["cidr", "Subnet (CIDR)"], ["range", "Range"], ["single", "Single address"]];
      return '<div class="nd-target-row" data-idx="' + i + '" style="display:flex;gap:6px;align-items:center;margin-bottom:6px">' +
        '<select class="form-input nd-t-kind" style="flex:0 0 150px">' +
          kinds.map(function (k) {
            return '<option value="' + k[0] + '"' + (t.kind === k[0] ? " selected" : "") + '>' + k[1] + '</option>';
          }).join("") +
        '</select>' +
        '<input type="text" class="form-input nd-t-value" style="flex:1" maxlength="64" ' +
          'placeholder="' + (t.kind === "range" ? "10.4.0.10-10.4.0.60" : t.kind === "single" ? "10.4.0.7" : "10.4.0.0/24") + '" ' +
          'value="' + escapeHtml(t.value || "") + '">' +
        '<button type="button" class="btn-icon nd-t-remove" title="Remove this target" aria-label="Remove this target">✕</button>' +
      '</div>';
    }

    function step2Html() {
      return '' +
        stepHead("Which addresses?",
          'Subnets, ranges or single addresses. Overlapping targets are fine — they are de-duplicated — and loopback, ' +
          'link-local (including the cloud-metadata address), multicast and reserved addresses are always excluded, ' +
          'whatever you type.') +
        '<div id="nd-targets">' + draft.targets.map(targetRowHtml).join("") + '</div>' +
        '<button type="button" class="btn btn-secondary btn-sm" id="nd-add-target">+ Add target</button>' +
        '<div class="aw-preview-box aw-preview-compact" id="nd-target-preview" style="margin-top:1rem">' + previewShell("Enter a target to see what it covers.", "") + '</div>';
    }

    /** ONE shell for every preview state so the box can't change height. */
    function previewShell(headHtml, bodyHtml) {
      return '<p class="aw-preview-head">' + headHtml + '</p>' +
        '<div class="aw-preview-body">' + (bodyHtml || "") + '</div>';
    }

    function renderTargets() {
      var host = document.getElementById("nd-targets");
      if (!host) return;
      host.innerHTML = draft.targets.map(targetRowHtml).join("");
      schedulePreview();
    }

    function wireStep2() {
      var panel = document.getElementById("nd-step-2");
      if (!panel) return;
      var add = document.getElementById("nd-add-target");
      if (add) add.addEventListener("click", function () {
        collectStep2();
        draft.targets.push({ kind: "cidr", value: "" });
        renderTargets();
      });
      // Delegated so a re-render needs no re-wire.
      panel.addEventListener("click", function (ev) {
        var rm = ev.target.closest ? ev.target.closest(".nd-t-remove") : null;
        if (!rm) return;
        collectStep2();
        var row = rm.closest(".nd-target-row");
        var idx = Number(row && row.getAttribute("data-idx"));
        if (Number.isFinite(idx)) draft.targets.splice(idx, 1);
        if (!draft.targets.length) draft.targets.push({ kind: "cidr", value: "" });
        renderTargets();
      });
      panel.addEventListener("input", function (ev) {
        if (ev.target.classList && ev.target.classList.contains("nd-t-value")) schedulePreview();
      });
      panel.addEventListener("change", function (ev) {
        if (ev.target.classList && ev.target.classList.contains("nd-t-kind")) { collectStep2(); renderTargets(); }
      });
    }

    function collectStep2() {
      var rows = document.querySelectorAll("#nd-targets .nd-target-row");
      if (!rows.length) return;
      var out = [];
      rows.forEach(function (row) {
        var kind = row.querySelector(".nd-t-kind");
        var value = row.querySelector(".nd-t-value");
        out.push({ kind: (kind && kind.value) || "cidr", value: ((value && value.value) || "").trim() });
      });
      draft.targets = out;
    }

    function validateStep2() {
      collectStep2();
      var filled = draft.targets.filter(function (t) { return t.value; });
      if (!filled.length) return "Add at least one address, range or subnet to scan.";
      draft.targets = filled;
      return null;
    }

    function schedulePreview() {
      if (previewTimer) clearTimeout(previewTimer);
      previewTimer = setTimeout(runPreview, 500);
    }

    async function runPreview() {
      var box = document.getElementById("nd-target-preview");
      if (!box) return;
      collectStep2();
      var targets = draft.targets.filter(function (t) { return t.value; });
      if (!targets.length) { box.innerHTML = previewShell("Enter a target to see what it covers.", ""); return; }
      box.innerHTML = previewShell("Checking…", "");
      try {
        var r = await api.networkScans.previewTargets({ targets: targets });
        var head = '<strong>' + r.total + '</strong> address' + (r.total === 1 ? "" : "es") + ' to scan';
        if (r.alreadyKnown) head += ' · <strong>' + r.alreadyKnown + '</strong> already in inventory (skipped)';
        if (r.dropped) {
          var why = [];
          if (r.droppedBy.excluded) why.push(r.droppedBy.excluded + " reserved");
          if (r.droppedBy.cap) why.push(r.droppedBy.cap + " over the cap");
          if (r.droppedBy.invalid) why.push(r.droppedBy.invalid + " unusable target(s)");
          head += ' · <span style="color:var(--color-warning)">' + escapeHtml(why.join(", ")) + '</span>';
        }
        var errs = (r.perTarget || []).map(function (t, i) {
          return t.error ? '<div style="color:var(--color-danger);font-size:0.82rem">Target ' + (i + 1) + ': ' + escapeHtml(t.error) + '</div>' : "";
        }).join("");
        // No address list: the question this preview answers is "did I type
        // what I meant?", and the COUNT answers it. Listing 254 addresses (or
        // a summary of them) was noise on every keystroke.
        box.innerHTML = previewShell(head, errs);
      } catch (err) {
        box.innerHTML = previewShell("Preview unavailable", '<div class="hint">' + escapeHtml((err && err.message) || String(err)) + '</div>');
      }
    }

    // ═════════════════════════════════════════════════════════════════════
    //  Step 3 — Methods
    // ═════════════════════════════════════════════════════════════════════

    function methodFor(type) {
      return draft.methods.find(function (m) { return m.type === type; }) || null;
    }

    function methodCardHtml(type) {
      var meta = METHOD_META[type];
      var picked = methodFor(type);
      var on = !!picked;
      var ids = (picked && picked.credentialIds) || [];
      var pool = meta.credType ? credsOfType(meta.credType) : [];
      var available = pool.filter(function (c) { return ids.indexOf(c.id) === -1; });

      var credBlock = "";
      if (meta.credType) {
        credBlock =
          '<div class="nd-m-creds" data-type="' + type + '" style="display:' + (on ? "" : "none") + ';margin:0.4rem 0 0 1.6rem">' +
            (ids.length
              ? '<ol style="margin:0 0 0.4rem 1.1rem;font-size:0.86rem">' + ids.map(function (id, i) {
                  return '<li style="margin-bottom:2px">' + escapeHtml(credName(id)) +
                    ' <button type="button" class="btn-icon nd-cred-up" data-type="' + type + '" data-idx="' + i + '" title="Try earlier" aria-label="Try earlier">▲</button>' +
                    '<button type="button" class="btn-icon nd-cred-down" data-type="' + type + '" data-idx="' + i + '" title="Try later" aria-label="Try later">▼</button>' +
                    '<button type="button" class="btn-icon nd-cred-rm" data-type="' + type + '" data-idx="' + i + '" title="Remove" aria-label="Remove">✕</button>' +
                  '</li>';
                }).join("") + '</ol>'
              : '<p class="hint" style="margin:0 0 0.35rem 0;color:var(--color-warning)">No credential selected — this method can\'t be attempted.</p>') +
            (available.length
              ? '<select class="form-input nd-cred-add" data-type="' + type + '" style="max-width:340px">' +
                  '<option value="">Add a credential…</option>' +
                  available.map(function (c) { return '<option value="' + escapeHtml(c.id) + '">' + escapeHtml(c.name) + '</option>'; }).join("") +
                '</select>'
              : (pool.length
                  ? '<p class="hint" style="margin:0">Every ' + escapeHtml(meta.credType) + ' credential is already listed.</p>'
                  : '<p class="hint" style="margin:0">No ' + escapeHtml(meta.credType) + ' credentials exist yet — add one on Server Settings → Credentials.</p>')) +
            '<p class="hint" style="margin:0.35rem 0 0 0;font-size:0.78rem">Tried in this order; the first that answers wins, and the rest are not attempted.</p>' +
          '</div>';
      }

      return '<div class="nd-method-card" style="border:1px solid var(--color-border);border-radius:var(--radius-sm);padding:0.6rem;margin-bottom:0.5rem">' +
        '<label style="display:flex;align-items:center;gap:8px;margin:0;cursor:pointer">' +
          '<input type="checkbox" class="nd-m-enable" data-type="' + type + '"' + (on ? " checked" : "") + ' style="width:auto">' +
          '<strong>' + escapeHtml(meta.label) + '</strong>' +
        '</label>' +
        '<p class="hint" style="margin:0.2rem 0 0 1.6rem;font-size:0.82rem">' + escapeHtml(meta.hint) + '</p>' +
        credBlock +
      '</div>';
    }

    function step3Html() {
      return '' +
        stepHead("How should Polaris ask?",
          'Methods are tried top to bottom, and each method’s credentials in the order you list them — the first ' +
          'that answers wins, and the rest are not attempted.') +
        '<div id="nd-methods">' + METHOD_ORDER.map(methodCardHtml).join("") + '</div>' +
        '<p class="hint" style="margin-top:0.75rem">Leaving <strong>ICMP</strong> off sends every address straight to the credentialed methods — ' +
          'right for a range where ping is firewalled off, and much slower on a wide one.</p>';
    }

    function renderStep3() {
      var host = document.getElementById("nd-methods");
      if (host) host.innerHTML = METHOD_ORDER.map(methodCardHtml).join("");
    }

    function wireStep3() {
      var panel = document.getElementById("nd-step-3");
      if (!panel) return;
      panel.addEventListener("change", function (ev) {
        var t = ev.target;
        if (t.classList && t.classList.contains("nd-m-enable")) {
          var type = t.getAttribute("data-type");
          if (t.checked) {
            if (!methodFor(type)) draft.methods.push({ type: type, credentialIds: [] });
          } else {
            draft.methods = draft.methods.filter(function (m) { return m.type !== type; });
          }
          // Keep the stored order as the operator's priority order.
          draft.methods.sort(function (a, b) { return METHOD_ORDER.indexOf(a.type) - METHOD_ORDER.indexOf(b.type); });
          renderStep3();
          return;
        }
        if (t.classList && t.classList.contains("nd-cred-add") && t.value) {
          var m = methodFor(t.getAttribute("data-type"));
          if (m && m.credentialIds.indexOf(t.value) === -1) m.credentialIds.push(t.value);
          renderStep3();
        }
      });
      panel.addEventListener("click", function (ev) {
        var btn = ev.target.closest ? ev.target.closest(".nd-cred-up, .nd-cred-down, .nd-cred-rm") : null;
        if (!btn) return;
        var m = methodFor(btn.getAttribute("data-type"));
        if (!m) return;
        var i = Number(btn.getAttribute("data-idx"));
        if (!Number.isFinite(i)) return;
        if (btn.classList.contains("nd-cred-rm")) m.credentialIds.splice(i, 1);
        else if (btn.classList.contains("nd-cred-up") && i > 0) {
          m.credentialIds.splice(i - 1, 0, m.credentialIds.splice(i, 1)[0]);
        } else if (btn.classList.contains("nd-cred-down") && i < m.credentialIds.length - 1) {
          m.credentialIds.splice(i + 1, 0, m.credentialIds.splice(i, 1)[0]);
        }
        renderStep3();
      });
    }

    function collectStep3() { /* the draft is mutated as controls change */ }

    function validateStep3() {
      if (!draft.methods.length) return "Select at least one probe method.";
      var bad = draft.methods.find(function (m) {
        return m.type !== "icmp" && !(m.credentialIds || []).length;
      });
      if (bad) return "Select at least one credential for " + METHOD_META[bad.type].label + ", or turn it off.";
      return null;
    }

    // ═════════════════════════════════════════════════════════════════════
    //  Step 4 — Run
    // ═════════════════════════════════════════════════════════════════════

    function renderStep4(state) {
      var panel = document.getElementById("nd-step-4");
      if (!panel) return;
      var run = state || null;
      var canRun = canWrite();
      // Running a SHARED Discovery you don't own is the point of publishing
      // one, so the run doesn't save first — there is nothing of yours to save.
      var savesFirst = canEditDraft(draft);

      if (!run) {
        panel.innerHTML =
          stepHead("Run the scan",
            savesFirst
              ? 'Starting saves the Discovery first, so you can re-run it later. You can close this window once it is ' +
                'going — the scan keeps running, and reopening this step picks it back up.'
              : 'This Discovery belongs to someone else, so running it changes nothing about it. You can close this ' +
                'window once it is going — the scan keeps running, and reopening this step picks it back up.') +
          (canRun
            ? '<button type="button" class="btn btn-primary" id="nd-run-btn">' +
                (savesFirst ? "Save &amp; start scan" : "Start scan") + '</button>'
            : '<p class="hint" style="color:var(--color-warning)">You don\'t have permission to run a Discovery.</p>') +
          '<div id="nd-run-status" style="margin-top:1rem"></div>';
        var b = document.getElementById("nd-run-btn");
        if (b) b.addEventListener("click", startRun);
        return;
      }

      var total = run.totalTargets || 0;
      var done = run.scannedCount || 0;
      var pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
      var live = run.status === "running" || run.status === "queued";
      panel.innerHTML =
        stepHead("Run the scan",
          'The scan keeps running if you close this window; reopening this step picks it back up.') +
        '<div id="nd-run-status">' +
          '<p style="margin:0 0 0.35rem 0">' +
            (live ? '<span class="query-spinner"></span> ' : "") +
            '<strong>' + done + '</strong> / ' + total + ' scanned · <strong>' + (run.hitCount || 0) + '</strong> responded' +
            (run.skippedKnownCount ? ' · ' + run.skippedKnownCount + ' already in inventory' : "") +
            (run.droppedTargetCount ? ' · ' + run.droppedTargetCount + ' dropped' : "") +
          '</p>' +
          '<div style="height:6px;background:var(--color-bg-tertiary);border-radius:3px;overflow:hidden">' +
            '<div style="height:100%;width:' + pct + '%;background:var(--color-accent);transition:width 0.3s"></div>' +
          '</div>' +
          '<p class="hint" style="margin:0.4rem 0 0 0">Status: ' + escapeHtml(run.status) +
            (run.stalled ? ' <span style="color:var(--color-warning)">(the worker stopped reporting)</span>' : "") +
            (run.error ? ' — <span style="color:var(--color-danger)">' + escapeHtml(run.error) + '</span>' : "") +
          '</p>' +
          (live && canRun ? '<button type="button" class="btn btn-secondary btn-sm" id="nd-cancel-run" style="margin-top:0.6rem">Cancel scan</button>' : "") +
          (!live && canRun ? '<button type="button" class="btn btn-secondary btn-sm" id="nd-run-btn" style="margin-top:0.6rem">Scan again</button>' : "") +
          (!live ? '<p class="hint" style="margin-top:0.6rem">Continue to <strong>Results</strong> to choose what to add.</p>' : "") +
        '</div>';
      var cancel = document.getElementById("nd-cancel-run");
      if (cancel) cancel.addEventListener("click", async function () {
        cancel.disabled = true;
        try { await api.networkScans.cancelRun(draft.runId); showToast("Cancel requested.", "info"); }
        catch (err) { showToast((err && err.message) || "Cancel failed", "error"); cancel.disabled = false; }
      });
      var again = document.getElementById("nd-run-btn");
      if (again) again.addEventListener("click", startRun);
    }

    /** Save (create or update), POST a run, then poll it. */
    async function startRun() {
      var problem = validateStep1() || validateStep2() || validateStep3();
      if (problem) { showToast(problem, "error"); return; }
      var btn = document.getElementById("nd-run-btn");
      if (btn) btn.disabled = true;
      try {
        if (canEditDraft(draft)) await saveDraft({ quiet: true });
        var resp = await api.networkScans.run(draft.id);
        draft.runId = resp.run.id;
        draft.hits = [];
        draft.selected = [];
        pollTries = 0;
        renderStep4(resp.run);
        schedulePoll();
      } catch (err) {
        showToast((err && err.message) || "Could not start the scan", "error");
        if (btn) btn.disabled = false;
      }
    }

    function schedulePoll() {
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = setTimeout(pollOnce, POLL_MS);
    }

    /**
     * Self-rescheduling poll with a try cap; a per-tick error is swallowed so
     * one blip doesn't abandon the watch (the runScriptTest shape).
     */
    async function pollOnce() {
      pollTimer = null;
      if (!draft.runId) return;
      pollTries += 1;
      var run = null;
      try { run = (await api.networkScans.getRun(draft.runId)).run; } catch (_) { run = null; }
      if (run) {
        draft.hits = Array.isArray(run.hits) ? run.hits : [];
        if (step === 4) renderStep4(run);
        if (TERMINAL[run.status]) {
          if (run.status === "error") showToast("The scan failed: " + (run.error || "unknown error"), "error");
          if (step === 5) renderStep5();
          return;
        }
      }
      if (pollTries > POLL_MAX_TRIES) {
        showToast("Stopped watching the scan — reopen this Discovery to check on it.", "info");
        return;
      }
      schedulePoll();
    }

    /** Re-attach to a run that is still in flight (or just show its result). */
    async function attachRun() {
      if (!draft.runId) {
        // Editing a saved Discovery: adopt its newest run so closing the modal
        // mid-scan doesn't lose it.
        if (draft.id) {
          try {
            var list = await api.networkScans.list();
            var mine = (list.scans || []).find(function (s) { return s.id === draft.id; });
            if (mine && mine.latestRun) draft.runId = mine.latestRun.id;
          } catch (_) { /* fall through to the start button */ }
        }
        if (!draft.runId) { renderStep4(null); return; }
      }
      try {
        var run = (await api.networkScans.getRun(draft.runId)).run;
        draft.hits = Array.isArray(run.hits) ? run.hits : [];
        renderStep4(run);
        if (!TERMINAL[run.status]) { pollTries = 0; schedulePoll(); }
      } catch (_) {
        draft.runId = null;
        renderStep4(null);
      }
    }

    function collectStep4() { /* nothing typed here */ }
    function validateStep4() {
      if (!draft.runId) return "Run the scan before choosing what to add.";
      return null;
    }

    // ═════════════════════════════════════════════════════════════════════
    //  Step 5 — Results
    // ═════════════════════════════════════════════════════════════════════

    function renderStep5() {
      var panel = document.getElementById("nd-step-5");
      if (!panel) return;
      var hits = draft.hits || [];
      if (!hits.length) {
        panel.innerHTML = stepHead("What answered?",
            'Choose which responders to add to inventory.') +
          '<p class="hint" style="margin-top:0">Nothing answered yet. ' +
          (draft.runId ? "If the scan has finished, nothing on those addresses responded to the methods you chose." : "Run the scan on the previous step.") + '</p>';
        return;
      }
      var rows = hits.map(function (h) {
        var checked = draft.selected.indexOf(h.address) !== -1;
        var errs = h.errors ? Object.keys(h.errors).map(function (k) { return k + ": " + h.errors[k]; }).join("; ") : "";
        return '<tr>' +
          '<td><input type="checkbox" class="nd-hit" data-address="' + escapeHtml(h.address) + '"' + (checked ? " checked" : "") + '></td>' +
          '<td style="font-family:monospace">' + escapeHtml(h.address) + '</td>' +
          '<td>' + escapeHtml((h.respondedTo || []).join(", ")) + '</td>' +
          '<td>' + escapeHtml((h.identity && h.identity.hostname) || "—") + '</td>' +
          '<td>' + escapeHtml(hitIdentityLine(h) || "—") + '</td>' +
          '<td class="hint" style="font-size:0.78rem" title="' + escapeHtml(errs) + '">' + escapeHtml(errs ? errs.slice(0, 60) + (errs.length > 60 ? "…" : "") : "") + '</td>' +
        '</tr>';
      }).join("");
      panel.innerHTML =
        stepHead("What answered?",
          'Choose which responders to add to inventory. Addresses an asset already carries were skipped before any ' +
          'packet was sent, so everything listed here is new.') +
        '<p style="margin-top:0"><strong>' + hits.length + '</strong> responder' + (hits.length === 1 ? "" : "s") + '.</p>' +
        '<div style="margin-bottom:0.5rem">' +
          '<button type="button" class="btn btn-secondary btn-sm" id="nd-sel-all">Select all</button> ' +
          '<button type="button" class="btn btn-secondary btn-sm" id="nd-sel-none">Select none</button> ' +
          '<span class="hint" id="nd-sel-count" style="margin-left:0.5rem"></span>' +
        '</div>' +
        '<div class="table-wrapper" style="max-height:340px;overflow:auto">' +
          '<table class="data-table"><thead><tr>' +
            '<th style="width:32px"></th><th>Address</th><th>Answered</th><th>Hostname</th><th>Identified as</th><th>Notes</th>' +
          '</tr></thead><tbody>' + rows + '</tbody></table>' +
        '</div>';
      var all = document.getElementById("nd-sel-all");
      var none = document.getElementById("nd-sel-none");
      if (all) all.addEventListener("click", function () {
        draft.selected = hits.map(function (h) { return h.address; });
        renderStep5();
      });
      if (none) none.addEventListener("click", function () { draft.selected = []; renderStep5(); });
      panel.addEventListener("change", function (ev) {
        if (!ev.target.classList || !ev.target.classList.contains("nd-hit")) return;
        var addr = ev.target.getAttribute("data-address");
        var at = draft.selected.indexOf(addr);
        if (ev.target.checked && at === -1) draft.selected.push(addr);
        if (!ev.target.checked && at !== -1) draft.selected.splice(at, 1);
        syncSelCount();
      });
      syncSelCount();
    }

    function syncSelCount() {
      var el = document.getElementById("nd-sel-count");
      if (el) el.textContent = draft.selected.length + " selected";
    }

    function collectStep5() { /* selection is mutated as boxes change */ }
    function validateStep5() { return null; } // adding nothing is a valid outcome

    // ═════════════════════════════════════════════════════════════════════
    //  Step 6 — Monitoring
    // ═════════════════════════════════════════════════════════════════════

    /** The selected responders, grouped by the method that identified them. */
    function selectedGroups() {
      var groups = {};
      (draft.hits || []).forEach(function (h) {
        if (draft.selected.indexOf(h.address) === -1) return;
        var key = groupKeyForHit(h);
        (groups[key] = groups[key] || []).push(h);
      });
      return groups;
    }

    function amonAvailable() {
      return typeof _autoMonitorInterfacesHTML === "function" &&
             typeof _readAutoMonitorInterfaces === "function";
    }

    function renderStep6() {
      var panel = document.getElementById("nd-step-6");
      if (!panel) return;
      var groups = selectedGroups();
      var keys = Object.keys(groups);
      var head = stepHead("What should be monitored?",
        'Grouped by what answered, because that is what decides which pins are even possible.');
      if (!keys.length) {
        panel.innerHTML = head +
          '<p class="hint" style="margin-top:0">Select some responders on the previous step to choose what to monitor on them.</p>';
        return;
      }
      if (!amonAvailable()) {
        panel.innerHTML = head + '<p class="hint" style="margin-top:0;color:var(--color-warning)">' +
          'The monitoring selection builder failed to load — reload the page. You can still add the devices without pins.</p>';
        return;
      }
      panel.innerHTML = head + keys.map(groupSectionHtml).join("");
      keys.forEach(wireGroup);
    }

    function groupSectionHtml(key) {
      var groups = selectedGroups();
      var hits = groups[key] || [];
      var withInv = hits.filter(function (h) { return (h.interfaces || []).length; }).length;
      var saved = draft.autoMonitor[key] || {};
      var prefix = "nd-am-" + key + "-";
      var storPrefix = "nd-st-" + key + "-";
      var label = (METHOD_META[key] && METHOD_META[key].label) || key;

      var note = withInv
        ? '<p class="hint" style="margin:0 0 0.5rem 0">' + withInv + ' of ' + hits.length +
            ' reported their interfaces during the scan, so the lists below are real.</p>'
        : '<p class="hint" style="margin:0 0 0.5rem 0;color:var(--color-warning)">' +
            'These devices reported no interfaces during the scan' +
            (key === "icmp" ? " (ICMP can't)" : key === "ssh" || key === "winrm" ? " (they only report once an agent runs)" : "") +
            '. A pattern or type rule still applies later, as devices report.</p>';

      return '<div style="border:1px solid var(--color-border);border-radius:var(--radius-sm);padding:0.75rem;margin-bottom:0.75rem">' +
        '<h4 style="margin:0 0 0.35rem 0">' + escapeHtml(label) + ' — ' + hits.length + ' device' + (hits.length === 1 ? "" : "s") + '</h4>' +
        note +
        _autoMonitorInterfacesHTML(prefix, "device", saved.interfaces || null, null, true, { hideLldp: true }) +
        (typeof _autoMonitorStorageHTML === "function"
          ? _autoMonitorStorageHTML(storPrefix, "device", saved.storage || null, true)
          : "") +
      '</div>';
    }

    /**
     * Fill the shared builder's checklists from the SCAN's inventory and wire
     * its master checkboxes.
     *
     * The integrations page's own wire function loads those lists from
     * `/integrations/:id/interface-aggregate`, which is assets that already
     * exist and have been polled — neither is true here. The row contract is
     * the collector's own selector, so filling it this way is what keeps ONE
     * definition of the selection vocabulary.
     */
    function wireGroup(key) {
      var prefix = "nd-am-" + key + "-";
      var storPrefix = "nd-st-" + key + "-";
      var hits = selectedGroups()[key] || [];

      // Interfaces: distinct names + the types actually observed.
      var names = [];
      var types = {};
      hits.forEach(function (h) {
        (h.interfaces || []).forEach(function (i) {
          if (names.indexOf(i.ifName) === -1) names.push(i.ifName);
          if (i.ifType) types[i.ifType] = 1;
        });
      });
      var saved = draft.autoMonitor[key] || {};
      var savedNames = (saved.interfaces && saved.interfaces.byNames && saved.interfaces.byNames.names) || [];
      fillNameList(prefix + "names-list", prefix, names, savedNames, "data-name-checkbox",
        "No interfaces were reported by these devices — use a pattern or type rule instead.");
      fillTypeList(prefix + "types-options", prefix, Object.keys(types),
        (saved.interfaces && saved.interfaces.byTypes && saved.interfaces.byTypes.types) || []);
      wireMasters(prefix);

      // Storage mounts.
      if (typeof _autoMonitorStorageHTML === "function") {
        var mounts = [];
        hits.forEach(function (h) {
          (h.storage || []).forEach(function (s) { if (mounts.indexOf(s.mountPath) === -1) mounts.push(s.mountPath); });
        });
        var savedMounts = (saved.storage && saved.storage.byNames && saved.storage.byNames.names) || [];
        fillNameList(storPrefix + "names-list", storPrefix, mounts, savedMounts, "data-stor-name-checkbox",
          "No storage mounts were reported by these devices.");
        wireMasters(storPrefix);
      }
    }

    /** Render the checkbox rows the shared collector reads. */
    function fillNameList(containerId, prefix, values, checkedValues, attr, emptyMsg) {
      var host = document.getElementById(containerId);
      if (!host) return;
      if (!values.length) { host.innerHTML = '<p class="hint" style="margin:0">' + escapeHtml(emptyMsg) + '</p>'; return; }
      host.innerHTML = values.map(function (v) {
        var on = checkedValues.indexOf(v) !== -1;
        return '<label style="display:flex;align-items:center;gap:6px;font-size:0.86rem;padding:1px 0">' +
          '<input type="checkbox" ' + attr + '="1" data-prefix="' + escapeHtml(prefix) + '" value="' + escapeHtml(v) + '"' +
            (on ? " checked" : "") + ' style="width:auto"> ' + escapeHtml(v) +
        '</label>';
      }).join("");
    }

    function fillTypeList(containerId, prefix, observed, checkedTypes) {
      var host = document.getElementById(containerId);
      if (!host) return;
      var list = observed.slice();
      // Keep a stored type the scan didn't observe rather than dropping it.
      checkedTypes.forEach(function (t) { if (list.indexOf(t) === -1) list.push(t); });
      if (!list.length) {
        host.innerHTML = '<p class="hint" style="margin:0">No interface types were reported by these devices.</p>';
        return;
      }
      host.innerHTML = list.map(function (t) {
        var on = checkedTypes.indexOf(t) !== -1;
        return typeof _amonTypeRowHTML === "function"
          ? _amonTypeRowHTML(prefix, t, on, false, t === "tunnel" && on)
          : '<label style="display:flex;align-items:center;gap:6px;font-size:0.88rem">' +
              '<input type="checkbox" data-type-checkbox="1" id="' + escapeHtml(prefix) + 'type-' + escapeHtml(t) + '" value="' + escapeHtml(t) + '"' +
              (on ? " checked" : "") + ' style="width:auto"> ' + escapeHtml(t) + '</label>';
      }).join("");
    }

    /** Master checkbox → panel visibility, the one bit of the page's wiring we need. */
    function wireMasters(prefix) {
      var masters = document.getElementsByName(prefix + "enable");
      for (var i = 0; i < masters.length; i++) {
        (function (box) {
          if (box._ndWired) return;
          box._ndWired = true;
          box.addEventListener("change", function () {
            var panel = document.getElementById(prefix + "panel-" + box.value);
            if (panel) panel.style.display = box.checked ? "" : "none";
          });
        })(masters[i]);
      }
    }

    function collectStep6() {
      if (!amonAvailable()) return;
      Object.keys(selectedGroups()).forEach(function (key) {
        var ifs = _readAutoMonitorInterfaces("nd-am-" + key + "-");
        var stor = typeof _readAutoMonitorStorage === "function"
          ? _readAutoMonitorStorage("nd-st-" + key + "-")
          : undefined;
        var block = {};
        // `undefined` means the card isn't rendered; `null` means "off". Only a
        // real selection is stored, so an untouched group saves nothing.
        if (ifs) block.interfaces = ifs;
        if (stor) block.storage = stor;
        if (Object.keys(block).length) draft.autoMonitor[key] = block;
        else delete draft.autoMonitor[key];
      });
    }

    function validateStep6() { return null; } // pinning nothing is valid

    // ═════════════════════════════════════════════════════════════════════
    //  Step 7 — Summary
    // ═════════════════════════════════════════════════════════════════════

    function pinSummary() {
      var keys = Object.keys(draft.autoMonitor || {});
      if (!keys.length) return "Nothing pinned";
      return keys.map(function (k) {
        var b = draft.autoMonitor[k] || {};
        var parts = [];
        if (b.interfaces) parts.push("interfaces");
        if (b.storage) parts.push("storage");
        return ((METHOD_META[k] && METHOD_META[k].label) || k) + ": " + (parts.join(" + ") || "none");
      }).join("; ");
    }

    function renderStep7() {
      var panel = document.getElementById("nd-step-7");
      if (!panel) return;
      var P = portability();
      panel.innerHTML =
        stepHead("Review &amp; finish",
          'Save the Discovery so it can be re-run, export it as a file, or add the responders you selected.') +
        '<dl class="review-grid">' +
          '<dt>Name</dt><dd>' + escapeHtml(draft.name || "—") + '</dd>' +
          '<dt>Targets</dt><dd>' + escapeHtml(draft.targets.map(function (t) { return t.value; }).filter(Boolean).join(", ") || "—") + '</dd>' +
          '<dt>Methods</dt><dd>' + escapeHtml(draft.methods.map(function (m) {
            return (METHOD_META[m.type] || {}).label + ((m.credentialIds || []).length ? " (" + m.credentialIds.length + " credential" + (m.credentialIds.length === 1 ? "" : "s") + ")" : "");
          }).join(", ")) + '</dd>' +
          '<dt>Responders</dt><dd>' + (draft.hits || []).length + ' found, <strong>' + draft.selected.length + '</strong> selected</dd>' +
          '<dt>Monitoring</dt><dd>' + escapeHtml(pinSummary()) + '</dd>' +
        '</dl>' +
        '<div style="margin-top:1rem;display:flex;gap:8px;flex-wrap:wrap">' +
          (P ? '<button type="button" class="btn btn-secondary" id="nd-export">Export config</button>' : "") +
          (draft.selected.length && canAdopt()
            ? '<button type="button" class="btn btn-primary" id="nd-adopt">Add ' + draft.selected.length + ' asset' + (draft.selected.length === 1 ? "" : "s") + '</button>'
            : "") +
        '</div>' +
        (draft.selected.length && !canAdopt()
          ? '<p class="hint" style="margin-top:0.6rem;color:var(--color-warning)">You can save and export this Discovery, but adding assets needs asset write permission. ' +
            'Hand the run to someone who has it — the results are saved with it.</p>'
          : "") +
        '<div id="nd-adopt-result" style="margin-top:0.75rem"></div>';

      var exportBtn = document.getElementById("nd-export");
      if (exportBtn) exportBtn.addEventListener("click", function () {
        var Pp = portability();
        if (!Pp) return;
        try {
          var file = Pp.buildExportFile(draftToInput(), { credentialName: credName });
          window.downloadJson(file, Pp.filenameForExport(draft.name));
          showToast("Exported.", "success");
        } catch (err) { showToast((err && err.message) || "Export failed", "error"); }
      });

      var adopt = document.getElementById("nd-adopt");
      if (adopt) adopt.addEventListener("click", async function () {
        if (!(await showConfirm("Add " + draft.selected.length + " asset(s) to inventory?"))) return;
        adopt.disabled = true;
        var out = document.getElementById("nd-adopt-result");
        try {
          var r = await api.networkScans.adopt(draft.runId, { addresses: draft.selected });
          showToast("Added " + r.created + " asset(s).", "success");
          if (out) {
            out.innerHTML = '<p><strong>' + r.created + '</strong> added.' +
              ((r.skipped || []).length ? ' ' + r.skipped.length + ' skipped.' : "") + '</p>' +
              ((r.skipped || []).length
                ? '<ul style="margin:0.25rem 0 0 1.1rem;font-size:0.85rem">' + r.skipped.map(function (s) {
                    return '<li>' + escapeHtml(s.address + " — " + s.reason) + '</li>';
                  }).join("") + '</ul>'
                : "");
          }
          if (window._reloadAssets) window._reloadAssets();
        } catch (err) {
          showToast((err && err.message) || "Could not add the assets", "error");
          adopt.disabled = false;
        }
      });
    }

    // ═════════════════════════════════════════════════════════════════════
    //  Save
    // ═════════════════════════════════════════════════════════════════════

    /** The wire shape — run state is deliberately not part of it. */
    function draftToInput() {
      return {
        name: draft.name,
        description: draft.description,
        visibility: draft.visibility === "public" ? "public" : "private",
        targets: draft.targets.filter(function (t) { return t.value; }),
        methods: draft.methods,
        autoMonitor: Object.keys(draft.autoMonitor || {}).length ? draft.autoMonitor : null,
      };
    }

    async function saveDraft(o) {
      o = o || {};
      var payload = draftToInput();
      var saved;
      if (draft.id) saved = (await api.networkScans.update(draft.id, payload)).scan;
      else saved = (await api.networkScans.create(payload)).scan;
      draft.id = saved.id;
      // Adopt the server's answer for the ownership facts. A brand-new draft
      // only learns who owns it here, and that is what keeps the Save button
      // and the visibility control correct for the rest of the session.
      draft.visibility = saved.visibility === "public" ? "public" : "private";
      draft.isOwner = saved.isOwner !== false;
      draft.createdBy = saved.createdBy || draft.createdBy || null;
      if (!o.quiet) showToast(editing ? "Discovery saved." : "Discovery created.", "success");
      if (window._reloadDiscoveries) window._reloadDiscoveries();
    }

    // ═════════════════════════════════════════════════════════════════════
    //  Shell
    // ═════════════════════════════════════════════════════════════════════

    var COLLECT = { 1: collectStep1, 2: collectStep2, 3: collectStep3, 4: collectStep4, 5: collectStep5, 6: collectStep6, 7: function () {} };
    var VALIDATE = { 1: validateStep1, 2: validateStep2, 3: validateStep3, 4: validateStep4, 5: validateStep5, 6: validateStep6, 7: function () { return null; } };

    function stepperHtml() {
      var html = '<div class="stepper" id="nd-stepper">';
      STEPS.forEach(function (label, i) {
        var n = i + 1;
        if (i > 0) html += '<div class="stepper-line" data-line="' + (n - 1) + '"></div>';
        html += '<div class="stepper-step" data-step="' + n + '">' +
          '<span class="stepper-num">' + n + "</span><span>" + escapeHtml(label) + "</span></div>";
      });
      return html + "</div>";
    }

    function updateStepper() {
      document.querySelectorAll("#nd-stepper .stepper-step").forEach(function (el) {
        var n = Number(el.getAttribute("data-step"));
        el.classList.toggle("active", n === step);
        el.classList.toggle("done", n < step);
        el.classList.toggle("clickable", n <= visited && n !== step);
      });
      document.querySelectorAll("#nd-stepper .stepper-line").forEach(function (el) {
        el.classList.toggle("done", Number(el.getAttribute("data-line")) < step);
      });
    }

    function syncFooter() {
      document.getElementById("nd-back").style.display = step > 1 ? "" : "none";
      document.getElementById("nd-next").style.display = step < STEPS.length ? "" : "none";
      var save = document.getElementById("nd-save");
      if (save) save.style.display = (step === STEPS.length || editing) ? "" : "none";
    }

    function stopTimers() {
      if (previewTimer) { clearTimeout(previewTimer); previewTimer = null; }
      if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    }

    function goToStep(n, o) {
      o = o || {};
      if (!o.skipCollect) COLLECT[step]();
      if (o.validate) {
        var problem = VALIDATE[step]();
        if (problem) { showToast(problem, "error"); return false; }
      }
      if (step === 2 && previewTimer) { clearTimeout(previewTimer); previewTimer = null; }
      document.getElementById("nd-step-" + step).classList.remove("visible");
      step = n;
      visited = Math.max(visited, n);
      if (n === 4) attachRun();
      if (n === 5) renderStep5();
      if (n === 6) renderStep6();
      if (n === 7) renderStep7();
      document.getElementById("nd-step-" + step).classList.add("visible");
      updateStepper();
      syncFooter();
      var body = document.querySelector(".modal-body");
      if (body) body.scrollTop = 0;
      if (n === 2) schedulePreview();
      return true;
    }

    var bodyHtml = stepperHtml() +
      '<div class="step-panel visible" id="nd-step-1">' + step1Html() + "</div>" +
      '<div class="step-panel" id="nd-step-2">' + step2Html() + "</div>" +
      '<div class="step-panel" id="nd-step-3">' + step3Html() + "</div>" +
      '<div class="step-panel" id="nd-step-4"></div>' +
      '<div class="step-panel" id="nd-step-5"></div>' +
      '<div class="step-panel" id="nd-step-6"></div>' +
      '<div class="step-panel" id="nd-step-7"></div>';

    var footer =
      '<button type="button" class="btn btn-secondary" id="nd-cancel">Close</button>' +
      '<button type="button" class="btn btn-secondary" id="nd-back" style="display:none">&larr; Back</button>' +
      '<button type="button" class="btn btn-primary" id="nd-next">Next &rarr;</button>' +
      (canEditDraft(draft)
        ? '<button type="button" class="btn btn-primary" id="nd-save" style="display:none">' +
            (editing ? "Save changes" : "Save discovery") + "</button>"
        : "");

    openModal(
      editing ? "Edit discovery" : importing ? "Imported discovery" : "New discovery",
      bodyHtml, footer, { wide: true },
    );

    document.getElementById("nd-next").addEventListener("click", function () {
      goToStep(step + 1, { validate: true });
    });
    document.getElementById("nd-back").addEventListener("click", function () { goToStep(step - 1); });
    // → / ← walk the steps and Enter advances while Next is showing, submitting
    // only on the last one (app.js § Stepped-modal keyboard navigation). The
    // submit is absent on a draft this operator can't edit; the helper takes
    // that as "Enter has nothing to submit here".
    if (typeof wireModalStepKeys === "function") {
      wireModalStepKeys({ back: "nd-back", next: "nd-next", submit: "nd-save" });
    }
    document.getElementById("nd-stepper").addEventListener("click", function (ev) {
      var el = ev.target.closest ? ev.target.closest(".stepper-step") : null;
      if (!el) return;
      var n = Number(el.getAttribute("data-step"));
      if (n <= visited && n !== step) goToStep(n);
    });
    document.getElementById("nd-cancel").addEventListener("click", function () {
      // A run keeps going server-side; that is the point of the run row.
      stopTimers();
      closeModal();
    });
    var saveBtn = document.getElementById("nd-save");
    if (saveBtn) saveBtn.addEventListener("click", async function () {
      COLLECT[step]();
      for (var i = 1; i <= 3; i++) {
        var problem = VALIDATE[i]();
        if (problem) { goToStep(i, { skipCollect: true }); showToast(problem, "error"); return; }
      }
      saveBtn.disabled = true;
      try { await saveDraft(); stopTimers(); closeModal(); }
      catch (err) { showToast((err && err.message) || "Save failed", "error"); saveBtn.disabled = false; }
    });

    wireStep1();
    wireStep2();
    wireStep3();
    updateStepper();
    syncFooter();
    schedulePreview();
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  Saved-Discovery list
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * The way back to something saved "for future use" — a wizard alone gives
   * none. Per-row verbs are a `showRowMenu` off the name, and below write level
   * the name renders as plain text rather than a trigger that opens an empty
   * menu (the automations.js convention).
   *
   * The list is own + shared (the server scopes it), so it carries an Owner
   * column: without one, a Discovery somebody else published reads as one you
   * forgot writing, and the row menu's missing Delete has no explanation.
   */
  async function openList() {
    var scans = [];
    try { scans = (await api.networkScans.list()).scans || []; }
    catch (err) { showToast((err && err.message) || "Could not load Discoveries", "error"); return; }

    var body;
    if (!scans.length) {
      body = '<p class="hint" style="margin:0">No Discoveries saved yet. ' +
        (permAtLeast("networkScan", "write") ? 'Use "+ Add Asset(s) → New discovery" to create one.' : "") + '</p>';
    } else {
      body = '<div class="table-wrapper"><table class="data-table"><thead><tr>' +
        '<th>Name</th><th>Owner</th><th>Targets</th><th>Last run</th><th>Result</th>' +
        '</tr></thead><tbody>' +
        scans.map(function (s) {
          var run = s.latestRun;
          var when = s.lastRunAt ? new Date(s.lastRunAt).toLocaleString() : "never";
          var result = run
            ? (run.active ? "running — " + (run.scannedCount || 0) + "/" + (run.totalTargets || 0)
               : run.status + " · " + (run.hitCount || 0) + " responder(s)")
            : "—";
          var nameCell = permAtLeast("networkScan", "write")
            ? '<button type="button" class="row-menu-trigger nd-list-name" data-id="' + escapeHtml(s.id) + '" aria-haspopup="menu">' + escapeHtml(s.name) + '</button>'
            : escapeHtml(s.name);
          return '<tr><td>' + nameCell + '</td>' +
            '<td class="hint">' + ownerCellHtml(s) + '</td>' +
            '<td class="hint">' + escapeHtml((s.targets || []).map(function (t) { return t.value; }).join(", ")) + '</td>' +
            '<td class="hint">' + escapeHtml(when) + '</td>' +
            '<td class="hint">' + escapeHtml(result) + '</td></tr>';
        }).join("") +
        '</tbody></table></div>';
    }

    openModal("Saved discoveries", body,
      '<button class="btn btn-secondary" onclick="closeModal()">Close</button>', { large: true });

    document.querySelectorAll(".nd-list-name").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var scan = scans.find(function (s) { return s.id === btn.getAttribute("data-id"); });
        if (!scan) return;
        showRowMenu(btn, listRowItems(scan), { label: "Actions for " + scan.name });
      });
    });
  }

  /**
   * Who a row belongs to, in one cell: "You" for your own, the author's
   * username for a shared one, and the word "Shared" as the badge that says
   * why you can see it at all.
   */
  function ownerCellHtml(scan) {
    var shared = scan && scan.visibility === "public";
    var who = scan && scan.isOwner ? "You" : ((scan && scan.createdBy) || "unknown");
    return escapeHtml(who) + (shared ? ' &middot; <span style="color:var(--color-text-tertiary)">Shared</span>' : "");
  }

  /**
   * Pure: the per-row verbs, each gated by the key its own route checks — plus,
   * since the visibility cutover, by whether the row is the caller's. Running
   * someone else's SHARED Discovery is exactly what publishing one is for, so
   * Run stays on `write` alone; editing and deleting it are the owner's, with
   * fullwrite as the housekeeping override. A verb the caller can't use is
   * OMITTED rather than shown disabled, the `_addAssetMenuItems` rule.
   */
  function listRowItems(scan) {
    var items = [];
    var writable = permAtLeast("networkScan", "write");
    var mine = !scan || scan.isOwner !== false || permAtLeast("networkScan", "fullwrite");
    if (writable) {
      items.push({ label: "Open…", onSelect: function () { open(scan).catch(function () {}); } });
      items.push({
        label: "Run now",
        title: "Starts a scan with the saved configuration",
        onSelect: async function () {
          try {
            await api.networkScans.run(scan.id);
            showToast("Scan started.", "success");
            openList().catch(function () {});
          } catch (err) { showToast((err && err.message) || "Could not start the scan", "error"); }
        },
      });
    }
    var P = window.PolarisDiscoveryPortability;
    if (P) {
      items.push({
        label: "Export config",
        onSelect: function () {
          try {
            window.downloadJson(P.buildExportFile(scan, {}), P.filenameForExport(scan.name));
            showToast("Exported.", "success");
          } catch (err) { showToast((err && err.message) || "Export failed", "error"); }
        },
      });
    }
    if (writable && mine) {
      items.push({ separator: true });
      items.push({
        label: "Delete",
        danger: true,
        onSelect: async function () {
          if (!(await showConfirm('Delete the Discovery "' + scan.name + '"? Its run history goes with it.'))) return;
          try {
            await api.networkScans.delete(scan.id);
            showToast("Deleted.", "success");
            openList().catch(function () {});
          } catch (err) { showToast((err && err.message) || "Delete failed", "error"); }
        },
      });
    }
    return items;
  }

  window.PolarisAssetDiscovery = {
    open: open,
    openList: openList,
    // Pure helpers, re-exported for the happy-dom unit suite.
    STEPS: STEPS,
    emptyDraft: emptyDraft,
    groupKeyForHit: groupKeyForHit,
    listRowItems: listRowItems,
    ownerCellHtml: ownerCellHtml,
    canEditDraft: canEditDraft,
    METHOD_ORDER: METHOD_ORDER,
  };
})();
