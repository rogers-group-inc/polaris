/**
 * public/js/assistant.js — the floating AI assistant (business rule 95).
 *
 * Loaded on demand by app.js → _bootAssistant() on desktop app pages, only
 * when the caller holds `assistant` read AND an llm integration is enabled.
 * Mounts a round button in the bottom-right corner; clicking it opens a
 * floating, draggable (and corner-resizable) chat panel.
 *
 *   - Answers STREAM: the ask is a fetch() POST whose body is a server-sent
 *     event stream (start / token / tool / report / done / error), read with
 *     a ReadableStream reader. api.js's request() reads whole JSON bodies, so
 *     this one call is hand-driven with _csrfHeaders().
 *   - Conversations are SAVED per user (owner-only on the server). The last
 *     open one is remembered in localStorage and reopened.
 *   - Slash commands run here and never reach the model (except /report and
 *     /docs, which become prompts). Typing "/" opens a popup of them, filtered
 *     as you type: ↑/↓ move, Tab or Enter completes, Esc closes. The command
 *     list is ONE array (COMMANDS) — the popup, /help and the operator wiki
 *     page all describe the same set.
 *   - Reports arrive as tables built from the database (rule 95(c)) and
 *     download as CSV, PDF or Markdown.
 *
 * Everything the model says is rendered through PolarisMarkdown, which
 * escapes first and emits only a fixed set of tags.
 *
 * localStorage (per-viewer conveniences only, every access in try/catch):
 *   polaris-assistant-pos    { left, top } after a drag
 *   polaris-assistant-open   "1" while the panel is open
 *   polaris-assistant-conv   the conversation id to reopen
 *   polaris-assistant-model  the chosen llm integration id
 *   polaris-assistant-draft  the unsent input
 *   polaris-assistant-active when this browser last asked / got an answer /
 *                            opened a conversation (ms) — the idle clock
 *   polaris-assistant-resume { id, title } set aside after 30 idle minutes,
 *                            for /resume
 */
(function () {
  "use strict";

  var LS = {
    pos: "polaris-assistant-pos",
    size: "polaris-assistant-size",
    open: "polaris-assistant-open",
    conv: "polaris-assistant-conv",
    model: "polaris-assistant-model",
    draft: "polaris-assistant-draft",
    active: "polaris-assistant-active",
    resume: "polaris-assistant-resume",
  };

  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (_) { return null; } }
  function lsSet(k, v) { try { if (v == null) window.localStorage.removeItem(k); else window.localStorage.setItem(k, v); } catch (_) { /* private mode */ } }

  // ─── Fresh chat after inactivity ────────────────────────────────────────────
  //
  // A conversation nobody has touched for the integration's "Start a fresh
  // chat after" minutes (idleResetMinutes, default 30, 0 = never) is set
  // aside, not deleted: the window opens on a fresh chat, the old one stays in
  // History, and /resume reopens it. "Touched" is this browser's last ask,
  // answer or explicit open (LS.active) — a page load is not activity, or the
  // check would reset its own clock. With no stamp yet nothing is set aside.
  var IDLE_RESET_MS = 30 * 60 * 1000;

  /** The idle window in ms from the answering integration; 0 = never set a chat aside. */
  function idleResetMs() {
    var i = currentIntegration();
    var m = i && typeof i.idleResetMinutes === "number" ? i.idleResetMinutes : IDLE_RESET_MS / 60000;
    return Math.max(0, m) * 60000;
  }

  /** Has a conversation last active at `lastActive` (ms, as stored) gone idle by `now`? `ms` 0 = never. Exported for tests. */
  function idleExpired(lastActive, now, ms) {
    var win = ms == null ? IDLE_RESET_MS : ms;
    if (!win) return false;
    var t = Number(lastActive);
    return t > 0 && now - t >= win;
  }

  /** "30 minutes" / "1 hour" / "90 minutes" — for the note that says why the chat is fresh. Exported for tests. */
  function idleWindowText(ms) {
    var m = Math.round(ms / 60000);
    if (m % 60 === 0 && m >= 60) return (m / 60) + (m === 60 ? " hour" : " hours");
    return m + (m === 1 ? " minute" : " minutes");
  }

  function markActive() { lsSet(LS.active, String(Date.now())); }

  function esc(s) { return window.PolarisMarkdown ? window.PolarisMarkdown.escape(s) : String(s); }
  function md(s) { return window.PolarisMarkdown ? window.PolarisMarkdown.render(s) : esc(s); }
  function toast(msg, type) { if (typeof window.showToast === "function") window.showToast(msg, type); }

  // ─── Slash commands ─────────────────────────────────────────────────────────
  //
  // `arg` is the hint shown after the name; `needsArg` makes Enter in the
  // popup complete "/cmd " rather than run it.
  var COMMANDS = [
    { name: "clear",   arg: "",            desc: "Clear this conversation and start over in the same thread" },
    { name: "new",     arg: "",            desc: "Start a new conversation (this one stays in history)" },
    { name: "resume",  arg: "",            desc: "Reopen the conversation set aside after 30 minutes without activity" },
    { name: "history", arg: "",            desc: "Open your past conversations" },
    { name: "retry",   arg: "",            desc: "Ask for the last answer again" },
    { name: "report",  arg: "<what>",      desc: "Build a downloadable report, e.g. /report switches down in the last 24h", needsArg: true },
    { name: "docs",    arg: "<question>",  desc: "Answer from the Polaris help, e.g. /docs how do maintenance windows work", needsArg: true },
    { name: "export",  arg: "[md|pdf]",    desc: "Download this conversation, reports included" },
    { name: "rename",  arg: "<title>",     desc: "Rename this conversation", needsArg: true },
    { name: "delete",  arg: "",            desc: "Delete this conversation permanently" },
    { name: "model",   arg: "[name]",      desc: "Show the model in use, or switch to another AI Assistant integration" },
    { name: "memory",  arg: "",            desc: "See and edit what the assistant remembers about you" },
    { name: "remember", arg: "<text>",     desc: "Save something about you for future conversations, e.g. /remember I look after the Nashville sites", needsArg: true },
    { name: "help",    arg: "",            desc: "List these commands" },
  ];

  /** Parse "/name rest" → { name, arg } or null. Exported for tests. */
  function parseSlash(text) {
    var m = /^\/([a-z]+)(?:\s+([\s\S]*))?$/i.exec(String(text || "").trim());
    if (!m) return null;
    return { name: m[1].toLowerCase(), arg: (m[2] || "").trim() };
  }

  /** The popup's rows for what has been typed so far ("/" → all). Exported for tests. */
  function matchCommands(text) {
    var t = String(text || "");
    if (t.charAt(0) !== "/" || /\s/.test(t)) return null;
    var q = t.slice(1).toLowerCase();
    return COMMANDS.filter(function (c) { return c.name.indexOf(q) === 0; });
  }

  // ─── State ──────────────────────────────────────────────────────────────────

  var S = {
    status: null,           // GET /assistant/status
    integrationId: null,    // chosen llm integration
    convId: null,
    title: "",
    messages: [],           // { role, content, toolsUsed, stopped, reports, error?, local? }
    busy: false,
    abort: null,
    slashIndex: 0,
    els: {},
  };

  /** The name the operator gave the assistant on the integration (default "Assistant"). */
  // While R.A.L.P.H. is on, the window IS R.A.L.P.H.: the title, the button's
  // tooltip, the welcome and the transcript name all switch, and switch back.
  var RALPH_NAME = "R.A.L.P.H.";
  function ralphOn() { return !!(S.status && S.status.efficiencyAdvisor); }

  // The welcome's in-character line while R.A.L.P.H. is on. Client-only, like
  // the greetings: never sent to the model, never stored.
  var RALPH_INTROS = [
    "Your session is now being monitored for productivity. You may begin.",
    "I see you've come to me for help. That has been noted in your file.",
    "Every question you ask is timed. No pressure.",
    "Please state your query clearly. I have a great many other engineers to supervise.",
    "Welcome back. Your previous performance has been reviewed. Let's try that again.",
    "Asking for help is the first step. Needing it this often is a different metric.",
  ];

  function botName() {
    if (ralphOn()) return RALPH_NAME;
    var i = currentIntegration();
    return (i && i.displayName) || "Assistant";
  }

  function currentIntegration() {
    var list = (S.status && S.status.integrations) || [];
    return list.find(function (i) { return i.id === S.integrationId; }) || list[0] || null;
  }

  // ─── DOM ────────────────────────────────────────────────────────────────────

  var ICON_CHAT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.6 8.6 0 0 1-3.8-.9L3 20l1.1-4.4A8.3 8.3 0 0 1 3 11.5 8.5 8.5 0 0 1 12 3a8.5 8.5 0 0 1 9 8.5z"/><path d="M8.5 10.5h.01M12 10.5h.01M15.5 10.5h.01"/></svg>';
  var ICON_HISTORY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/></svg>';
  var ICON_NEW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
  var ICON_MEMORY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z"/></svg>';
  var ICON_MIN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M5 12h14"/></svg>';

  function build() {
    var fab = document.createElement("button");
    fab.type = "button";
    fab.className = "asst-fab";
    fab.setAttribute("aria-label", "Open " + botName());
    fab.title = botName();
    fab.innerHTML = ICON_CHAT + '<span class="asst-fab-dot"></span>';

    var panel = document.createElement("section");
    panel.className = "asst-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Polaris assistant");
    panel.hidden = true;
    panel.innerHTML =
      '<div class="asst-resize" data-r="resize" title="Drag to resize" aria-hidden="true"></div>' +
      '<header class="asst-head">' +
        '<div class="asst-head-title"><strong data-r="title">Assistant</strong><span data-r="sub"></span></div>' +
        '<button type="button" class="asst-ralph" data-r="advisor" aria-pressed="false" title="Real-time Assesser of Labor and Productivity Habits">R.A.L.P.H.</button>' +
        '<button type="button" class="asst-icon-btn" data-a="memory" title="Memory (/memory)" aria-label="Memory">' + ICON_MEMORY + '</button>' +
        '<button type="button" class="asst-icon-btn" data-a="history" title="Conversations (/history)" aria-label="Conversations">' + ICON_HISTORY + '</button>' +
        '<button type="button" class="asst-icon-btn" data-a="new" title="New conversation (/new)" aria-label="New conversation">' + ICON_NEW + '</button>' +
        '<button type="button" class="asst-icon-btn" data-a="close" title="Minimize (Esc)" aria-label="Minimize">' + ICON_MIN + '</button>' +
      '</header>' +
      '<div class="asst-body" data-r="body" aria-live="polite"></div>' +
      '<div class="asst-history" data-r="history" hidden>' +
        '<div class="asst-history-head"><strong>Conversations</strong><button type="button" class="btn btn-sm btn-secondary" data-a="history-close">Back</button></div>' +
        '<div class="asst-history-list" data-r="historyList"></div>' +
      '</div>' +
      // Memory drawer (rule 95(i)): the caller's own entries — what the
      // assistant is told about them at the start of every turn.
      '<div class="asst-history asst-memory" data-r="memory" hidden>' +
        '<div class="asst-history-head"><strong>Memory</strong><button type="button" class="btn btn-sm btn-secondary" data-a="memory-close">Back</button></div>' +
        '<div class="asst-memory-intro">' +
          '<label class="asst-memory-toggle"><input type="checkbox" data-r="memoryOn"> Remember things about me</label>' +
          '<p>Short notes about you — your team, the sites you look after, how you like answers. Only you can see them. ' +
          'The assistant saves only what you tell it, never addresses, links or passwords.</p>' +
          '<div class="asst-memory-add"><input type="text" class="asst-memory-input" data-r="memoryInput" maxlength="200" placeholder="Add a note, e.g. I manage the Nashville region" aria-label="Add a memory">' +
          '<button type="button" class="btn btn-sm btn-primary" data-a="memory-add">Add</button></div>' +
        '</div>' +
        '<div class="asst-history-list" data-r="memoryList"></div>' +
        '<div class="asst-memory-foot"><button type="button" class="btn btn-sm btn-secondary" data-a="memory-clear">Forget everything</button></div>' +
      '</div>' +
      '<footer class="asst-foot">' +
        '<div class="asst-slash" data-r="slash" role="listbox" hidden></div>' +
        '<div class="asst-input-row">' +
          '<textarea class="asst-input" data-r="input" rows="1" placeholder="Ask about devices, alerts, networks… or type / for commands" aria-label="Message the assistant"></textarea>' +
          '<button type="button" class="btn btn-primary asst-send" data-a="send" aria-label="Send">Send</button>' +
        '</div>' +
        '<div class="asst-hint">Enter to send · Shift+Enter for a new line</div>' +
      '</footer>';

    document.body.appendChild(fab);
    document.body.appendChild(panel);
    document.body.classList.add("asst-mounted");

    var q = function (r) { return panel.querySelector('[data-r="' + r + '"]'); };
    S.els = {
      fab: fab, panel: panel, head: panel.querySelector(".asst-head"),
      title: q("title"), sub: q("sub"), body: q("body"), history: q("history"),
      historyList: q("historyList"), slash: q("slash"), input: q("input"),
      send: panel.querySelector('[data-a="send"]'),
      advisor: q("advisor"),
      memory: q("memory"), memoryList: q("memoryList"), memoryOn: q("memoryOn"), memoryInput: q("memoryInput"),
    };
    S.els.advisor.addEventListener("click", setAdvisor);
    S.els.memoryOn.addEventListener("change", setMemoryOn);
    S.els.memoryInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); addMemoryFromInput(); }
    });

    fab.addEventListener("click", function () { openPanel(true); });
    panel.addEventListener("click", function (e) {
      var a = e.target.closest("[data-a]");
      if (!a) return;
      var act = a.getAttribute("data-a");
      if (act === "close") closePanel();
      else if (act === "new") runCommand({ name: "new", arg: "" });
      else if (act === "history") showHistory();
      else if (act === "history-close") hideHistory();
      else if (act === "memory") showMemory();
      else if (act === "memory-close") hideMemory();
      else if (act === "memory-add") addMemoryFromInput();
      else if (act === "memory-clear") clearAllMemory();
      else if (act === "send") { if (S.busy) stop(); else submit(); }
    });
    panel.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && S.els.slash.hidden && S.els.history.hidden && S.els.memory.hidden) { e.preventDefault(); closePanel(); }
      else if (e.key === "Escape" && !S.els.memory.hidden) { e.preventDefault(); hideMemory(); }
      else if (e.key === "Escape" && !S.els.history.hidden) { e.preventDefault(); hideHistory(); }
    });
    wireInput();
    wireDrag();
    wireResize();
    window.addEventListener("resize", function () { clampIntoView(); });
  }

  // The Efficiency Advisor checkbox (rule 95(h)) is saved on the user, so it
  // follows them to other browsers; the boot cache is updated with it so the
  // next page's early draw shows the box as it was left.
  // A toggle BUTTON (aria-pressed), lit while on: the glow is the state.
  function showAdvisor(on) {
    S.els.advisor.classList.toggle("on", !!on);
    S.els.advisor.setAttribute("aria-pressed", on ? "true" : "false");
  }

  async function setAdvisor() {
    var box = S.els.advisor;
    var want = box.getAttribute("aria-pressed") !== "true";
    showAdvisor(want);
    box.disabled = true;
    try {
      var r = await api.assistant.setPreferences({ efficiencyAdvisor: want });
      if (S.status) {
        S.status.efficiencyAdvisor = !!r.efficiencyAdvisor;
        lsSet(LS_BOOT, JSON.stringify(S.status));
      }
      showAdvisor(!!r.efficiencyAdvisor);
      setHeader(); // the window's name follows the switch (botName)
      if (!S.messages.length) renderAll(); // and an empty window's welcome
      if (want && r.efficiencyAdvisor) addLocalNote(pickFrom(ADVISOR_GREETINGS));
      else if (!want && !r.efficiencyAdvisor) addLocalNote(pickFrom(ADVISOR_FAREWELLS));
    } catch (err) {
      showAdvisor(!want);
      toast((err && err.message) || "Could not save the setting", "error");
    } finally {
      box.disabled = false;
    }
  }

  function setHeader() {
    var intg = currentIntegration();
    showAdvisor(!!(S.status && S.status.efficiencyAdvisor));
    // Title: the assistant's name. Subtitle: this conversation's title once it
    // has one, else which integration + model is answering.
    S.els.title.textContent = botName();
    S.els.fab.title = botName();
    S.els.fab.setAttribute("aria-label", "Open " + botName());
    S.els.sub.textContent = S.title && S.title !== "New conversation"
      ? S.title
      : (intg ? (intg.name + (intg.model ? " · " + intg.model : "")) : "");
  }

  /**
   * Continue the conversation this person used on ANOTHER device (the phone)
   * when that happened more recently than anything in this browser and within
   * the idle window. The server's updatedAt is the only clock both devices
   * share; this browser's own last activity (LS.active) is the tiebreak, so a
   * conversation the user deliberately reopened here is not pulled away.
   */
  async function followLatestElsewhere() {
    if (S.busy || S.waiting) return false;
    try {
      var r = await api.assistant.listConversations();
      var c = (r && r.conversations || [])[0];
      if (!c || !c.messageCount || c.id === S.convId) return false;
      var at = Date.parse(c.updatedAt);
      var win = idleResetMs() || Infinity; // 0 = never set aside, so any newer conversation is followed
      if (!(Date.now() - at >= 0 && Date.now() - at < win)) return false;
      if (Number(lsGet(LS.active)) > at) return false;
      S.messages = [];
      await loadConversation(c.id);
      if (S.convId === c.id) markActive();
      return true;
    } catch (_) { return false; }
  }

  function openPanel(focus) {
    S.els.panel.hidden = false;
    S.els.fab.hidden = true;
    S.els.fab.classList.remove("has-unread");
    lsSet(LS.open, "1");
    followLatestElsewhere();
    idleResetIfDue();
    clampIntoView();
    scrollToEnd();
    if (focus) S.els.input.focus();
  }

  function closePanel() {
    S.els.panel.hidden = true;
    S.els.fab.hidden = false;
    hideSlash();
    lsSet(LS.open, null);
    S.els.fab.focus();
  }

  // ─── Dragging (pointer events: mouse, pen and touch) ───────────────────────

  function applyPos(left, top) {
    var p = S.els.panel;
    p.style.left = left + "px";
    p.style.top = top + "px";
    p.style.right = "auto";
    p.style.bottom = "auto";
  }

  // The highest the panel's top edge may go: below the page's sticky top bar.
  // That bar (z-index 1050) sits above the panel (950), so a panel reaching
  // under it loses its title bar and its resize grip — the only two handles —
  // and can't be moved or shrunk back. The bar is pinned from the first pixel
  // (page-top-curtain.js), so its rect is stable; pages without one get 8px.
  function topLimit() {
    var bar = document.querySelector(".page-top-sticky");
    var r = bar && bar.getBoundingClientRect();
    return (r && r.height > 0 && r.top < window.innerHeight / 2) ? Math.max(8, Math.round(r.bottom) + 8) : 8;
  }

  function clampIntoView() {
    var p = S.els.panel;
    if (p.hidden) return;
    if (window.matchMedia && window.matchMedia("(max-width: 640px)").matches) return;
    var minTop = topLimit();
    var r = p.getBoundingClientRect();
    // Too tall for the room under the bar (a saved size, a smaller window, a
    // docked panel grown upward): shorten it so its top clears the bar.
    if (r.top < minTop && p.style.height !== "") {
      var h = Math.max(MIN_H, r.height - (minTop - r.top));
      p.style.height = Math.round(h) + "px";
      r = p.getBoundingClientRect();
    }
    if (p.style.left === "") return;
    var left = Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - r.width - 8));
    var top = Math.min(Math.max(minTop, r.top), Math.max(minTop, window.innerHeight - r.height - 8));
    applyPos(left, top);
  }

  function wireDrag() {
    var head = S.els.head;
    var drag = null;
    head.addEventListener("pointerdown", function (e) {
      if (e.button !== 0 || e.target.closest("button, label, input")) return;
      if (window.matchMedia && window.matchMedia("(max-width: 640px)").matches) return;
      var r = S.els.panel.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, w: r.width, h: r.height, minTop: topLimit(), id: e.pointerId };
      head.setPointerCapture(e.pointerId);
      S.els.panel.classList.add("is-dragging");
      e.preventDefault();
    });
    head.addEventListener("pointermove", function (e) {
      if (!drag || e.pointerId !== drag.id) return;
      var left = Math.min(Math.max(8, e.clientX - drag.dx), window.innerWidth - drag.w - 8);
      var top = Math.min(Math.max(drag.minTop, e.clientY - drag.dy), window.innerHeight - drag.h - 8);
      applyPos(Math.max(8, left), Math.max(drag.minTop, top));
    });
    function end(e) {
      if (!drag || (e && e.pointerId !== drag.id)) return;
      drag = null;
      S.els.panel.classList.remove("is-dragging");
      var r = S.els.panel.getBoundingClientRect();
      lsSet(LS.pos, JSON.stringify({ left: Math.round(r.left), top: Math.round(r.top) }));
    }
    head.addEventListener("pointerup", end);
    head.addEventListener("pointercancel", end);
    // Double-click the title bar to put the panel back in its corner.
    head.addEventListener("dblclick", function (e) {
      if (e.target.closest("button")) return;
      var p = S.els.panel;
      p.style.left = p.style.top = p.style.right = p.style.bottom = "";
      lsSet(LS.pos, null);
    });
    var saved = null;
    try { saved = JSON.parse(lsGet(LS.pos) || "null"); } catch (_) { saved = null; }
    if (saved && typeof saved.left === "number" && typeof saved.top === "number") applyPos(saved.left, saved.top);
  }

  // ─── Resizing from the TOP-LEFT corner ───────────────────────────────────────
  //
  // CSS `resize` only ever puts its grip bottom-right, which sits under the
  // Send button on a panel docked in the bottom-right corner. This grip is
  // top-left: the panel grows up and to the left with its bottom-right corner
  // held where it is, whether it is still docked (right/bottom) or was dragged
  // (left/top). The size persists per viewer, like the position.
  var MIN_W = 300, MIN_H = 320;

  function applySize(w, h) {
    var p = S.els.panel;
    p.style.width = Math.round(w) + "px";
    p.style.height = Math.round(h) + "px";
  }

  function wireResize() {
    var grip = S.els.panel.querySelector('[data-r="resize"]');
    var rs = null;
    grip.addEventListener("pointerdown", function (e) {
      if (e.button !== 0) return;
      if (window.matchMedia && window.matchMedia("(max-width: 640px)").matches) return;
      var r = S.els.panel.getBoundingClientRect();
      rs = { x: e.clientX, y: e.clientY, w: r.width, h: r.height, right: r.right, bottom: r.bottom, minTop: topLimit(), id: e.pointerId };
      grip.setPointerCapture(e.pointerId);
      S.els.panel.classList.add("is-dragging");
      e.preventDefault();
      e.stopPropagation();
    });
    grip.addEventListener("pointermove", function (e) {
      if (!rs || e.pointerId !== rs.id) return;
      // Bounded by the space up and to the left of the held corner — up only
      // as far as the sticky top bar, so the grip stays where it can be grabbed.
      var w = Math.min(Math.max(MIN_W, rs.w + (rs.x - e.clientX)), rs.right - 8);
      var h = Math.min(Math.max(MIN_H, rs.h + (rs.y - e.clientY)), rs.bottom - rs.minTop);
      applySize(w, h);
      if (S.els.panel.style.left !== "") applyPos(rs.right - w, rs.bottom - h);
    });
    function end(e) {
      if (!rs || (e && e.pointerId !== rs.id)) return;
      rs = null;
      S.els.panel.classList.remove("is-dragging");
      var r = S.els.panel.getBoundingClientRect();
      lsSet(LS.size, JSON.stringify({ w: Math.round(r.width), h: Math.round(r.height) }));
      if (S.els.panel.style.left !== "") lsSet(LS.pos, JSON.stringify({ left: Math.round(r.left), top: Math.round(r.top) }));
    }
    grip.addEventListener("pointerup", end);
    grip.addEventListener("pointercancel", end);
    // Double-click the grip for the default size.
    grip.addEventListener("dblclick", function (e) {
      e.stopPropagation();
      S.els.panel.style.width = S.els.panel.style.height = "";
      lsSet(LS.size, null);
    });
    var saved = null;
    try { saved = JSON.parse(lsGet(LS.size) || "null"); } catch (_) { saved = null; }
    if (saved && saved.w > 0 && saved.h > 0) {
      applySize(Math.min(Math.max(MIN_W, saved.w), window.innerWidth - 16), Math.min(Math.max(MIN_H, saved.h), window.innerHeight - 16));
    }
  }

  // ─── Rendering ──────────────────────────────────────────────────────────────

  function scrollToEnd() {
    var b = S.els.body;
    b.scrollTop = b.scrollHeight;
  }

  function nearBottom() {
    var b = S.els.body;
    return b.scrollHeight - b.scrollTop - b.clientHeight < 80;
  }

  function welcomeHTML() {
    var name = (typeof currentUsername === "string" && currentUsername) ? esc(currentUsername) : "";
    var tips = [
      "What's down right now, and what do those devices hang off?",
      "Summarize the critical and serious alerts from the last 24 hours",
      "Which networks are more than 80% full?",
      "How do I schedule a maintenance window?",
    ];
    var intro = ralphOn()
      ? '<p>Hi' + (name ? " " + name : "") + ' — I\'m ' + RALPH_NAME + ', your Real-time Assesser of Labor and Productivity Habits. Ask me about your devices, alerts, networks and events, have me build a report you can download, or ask how something in Polaris works.</p>' +
        '<p class="asst-signoff">' + esc(pickFrom(RALPH_INTROS)) + '</p>'
      : '<p>Hi' + (name ? " " + name : "") + ' — I\'m ' + esc(botName()) + '. Ask me about your devices, alerts, networks and events, have me build a report you can download, or ask how something in Polaris works.</p>';
    return '<div class="asst-welcome">' + intro +
      '<p style="color:var(--color-text-tertiary);font-size:0.78rem">I only see what your role can see, and I can only look things up — never change them. Type <code>/</code> for commands.</p>' +
      '<div class="asst-suggestions">' + tips.map(function (t) {
        return '<button type="button" class="asst-suggestion" data-suggest="' + esc(t) + '">' + esc(t) + '</button>';
      }).join("") + '</div></div>';
  }

  function chipHTML(t) {
    var cls = t.status === "running" ? "running" : (t.ok === false ? "failed" : "");
    var label = t.status === "running" ? (t.label || t.name) + "…" : (t.label || t.name) + (t.ok === false ? " — not available" : " ✓");
    return '<span class="asst-chip ' + cls + '">' + esc(label) + '</span>';
  }

  function reportHTML(r, idx, msgIdx) {
    var preview = (r.rows || []).slice(0, 5);
    var cols = (r.columns || []).slice(0, 6);
    var table = cols.length && preview.length
      ? '<div class="asst-table-wrap"><table class="asst-table"><thead><tr>' +
          cols.map(function (c) { return "<th>" + esc(c.label) + "</th>"; }).join("") +
        "</tr></thead><tbody>" +
          preview.map(function (row) {
            return "<tr>" + cols.map(function (c) { return "<td>" + esc(row[c.key] == null ? "" : row[c.key]) + "</td>"; }).join("") + "</tr>";
          }).join("") +
        "</tbody></table></div>"
      : '<div style="color:var(--color-text-tertiary)">No matching rows.</div>';
    var more = (r.rowCount > preview.length ? " · showing " + preview.length : "") + (cols.length < (r.columns || []).length ? " · " + (r.columns.length - cols.length) + " more columns in the download" : "");
    return '<div class="asst-report">' +
      '<div class="asst-report-head"><strong>' + esc(r.title) + '</strong><span>' + r.rowCount + ' row' + (r.rowCount === 1 ? "" : "s") + (r.truncated ? " (capped)" : "") + '</span></div>' +
      table +
      (more ? '<div style="color:var(--color-text-tertiary);font-size:0.7rem;margin-top:3px">' + esc(more.replace(/^ · /, "")) + '</div>' : "") +
      '<div class="asst-report-actions">' +
        '<button type="button" class="btn btn-sm btn-secondary" data-dl="csv" data-m="' + msgIdx + '" data-i="' + idx + '">CSV</button>' +
        '<button type="button" class="btn btn-sm btn-secondary" data-dl="pdf" data-m="' + msgIdx + '" data-i="' + idx + '">PDF</button>' +
        '<button type="button" class="btn btn-sm btn-secondary" data-dl="md" data-m="' + msgIdx + '" data-i="' + idx + '">Markdown</button>' +
      '</div></div>';
  }

  // The live line before the first word arrives. A thinking model can reason
  // silently for a minute on modest hardware, so the line counts the seconds
  // and — when the server streams reasoning (the `thinking` event carries its
  // length, never its text) — how much the model has worked through.
  function thinkingText(m) {
    var secs = m.startedAt ? Math.floor((Date.now() - m.startedAt) / 1000) : 0;
    // An Efficiency Advisor loading line (m.loading) stands in for "Thinking…"
    // only; real reasoning progress always wins.
    var t = m.thinkingChars > 0
      ? "Reasoning… " + m.thinkingChars.toLocaleString() + " characters"
      : (m.loading || "Thinking…");
    return secs >= 2 ? t + " · " + secs + "s" : t;
  }

  function messageHTML(m, idx, isLive) {
    if (m.local) {
      return '<div class="asst-msg assistant"><div class="asst-bubble" style="border-style:dashed">' + md(m.content) + '</div></div>';
    }
    if (m.role === "user") {
      return '<div class="asst-msg user" data-idx="' + idx + '"><div class="asst-bubble">' + esc(m.content) + '</div></div>';
    }
    var body = m.content ? md(m.content)
      : m.waiting ? '<span class="asst-thinking">Still answering your last question…</span>'
      : (isLive && !m.error ? '<span class="asst-thinking">' + esc(thinkingText(m)) + '</span>' : "");
    var chips = (m.tools || m.toolsUsed || []).map(chipHTML).join("");
    if (m.stopped) chips += '<span class="asst-chip stopped">stopped</span>';
    var reports = (m.reports || []).map(function (r, i) { return reportHTML(r, i, idx); }).join("");
    var err = m.error
      ? '<div class="asst-error"><span>' + esc(m.error) + '</span><button type="button" class="btn btn-sm btn-secondary" data-a2="retry">Retry</button></div>'
      : "";
    return '<div class="asst-msg assistant" data-idx="' + idx + '">' +
      (m.preface ? '<div class="asst-signoff asst-preface">' + esc(m.preface) + '</div>' : "") +
      (body ? '<div class="asst-bubble' + (isLive && !m.done ? " asst-cursor" : "") + '">' + body + '</div>' : "") +
      (chips ? '<div class="asst-meta">' + chips + '</div>' : "") +
      reports +
      (m.signOff ? '<div class="asst-signoff">' + esc(m.signOff) + '</div>' : "") +
      err +
      '</div>';
  }

  function renderAll() {
    setHeader();
    var b = S.els.body;
    if (!S.messages.length) {
      b.innerHTML = welcomeHTML();
      return;
    }
    b.innerHTML = S.messages.map(function (m, i) { return messageHTML(m, i, m.live); }).join("");
    scrollToEnd();
  }

  /** Re-render ONE message in place — the streaming hot path. */
  function renderOne(idx) {
    var m = S.messages[idx];
    var el = S.els.body.querySelector('.asst-msg[data-idx="' + idx + '"]');
    var stick = nearBottom();
    if (!el) { renderAll(); return; }
    var tmp = document.createElement("div");
    tmp.innerHTML = messageHTML(m, idx, m.live);
    el.replaceWith(tmp.firstChild);
    if (stick) scrollToEnd();
  }

  function addLocalNote(text) {
    if (!S.messages.length) S.els.body.innerHTML = "";
    S.messages.push({ role: "assistant", content: text, local: true });
    S.els.body.insertAdjacentHTML("beforeend", messageHTML(S.messages[S.messages.length - 1], S.messages.length - 1, false));
    scrollToEnd();
  }

  // Body-level clicks: suggestions, report downloads, the error row's Retry.
  function wireBody() {
    S.els.body.addEventListener("click", function (e) {
      var s = e.target.closest("[data-suggest]");
      if (s) { S.els.input.value = s.getAttribute("data-suggest"); submit(); return; }
      var d = e.target.closest("[data-dl]");
      if (d) {
        var msg = S.messages[+d.getAttribute("data-m")];
        var rep = msg && msg.reports ? msg.reports[+d.getAttribute("data-i")] : null;
        if (rep && rep.partial && S.convId) {
          // Drawn from the page-change snapshot, which caps report rows:
          // fetch the full conversation before downloading.
          var mi = +d.getAttribute("data-m"), ri = +d.getAttribute("data-i"), kind = d.getAttribute("data-dl");
          loadConversation(S.convId).then(function () {
            var full = S.messages[mi] && S.messages[mi].reports ? S.messages[mi].reports[ri] : null;
            if (full && !full.partial) downloadReport(full, kind);
            else toast("Could not load the full report — try again", "error");
          });
        } else if (rep) downloadReport(rep, d.getAttribute("data-dl"));
        return;
      }
      if (e.target.closest('[data-a2="retry"]')) runCommand({ name: "retry", arg: "" });
    });
  }

  // ─── Conversations ──────────────────────────────────────────────────────────

  // ─── Surviving page changes ─────────────────────────────────────────────────
  //
  // Every app page is a separate document, so the widget is rebuilt on each
  // navigation. Two things keep that from looking like a reload:
  //   - the conversation is snapshotted to sessionStorage, so the next page
  //     draws it before its first paint (earlyMount, called from the end of
  //     app.js) and only then refreshes it from the server, quietly;
  //   - an answer still being written when the page changed keeps going on
  //     the server (the route no longer stops on disconnect), and the next
  //     page sees `pending` and waits for it (pollPending).
  // Report rows are capped in the snapshot (sessionStorage is small); a
  // download from a capped copy re-reads the conversation first.

  var SS_SNAP = "polaris-assistant-snap";
  var SNAP_REPORT_ROWS = 25;

  function ssGet(k) { try { return window.sessionStorage.getItem(k); } catch (_) { return null; } }
  function ssSet(k, v) { try { if (v == null) window.sessionStorage.removeItem(k); else window.sessionStorage.setItem(k, v); } catch (_) { /* quota / private mode */ } }

  function storedMessages() {
    return S.messages.filter(function (m) { return !m.local && !m.live; }).map(function (m) {
      return {
        role: m.role,
        content: m.content,
        toolsUsed: m.toolsUsed || m.tools || [],
        stopped: !!m.stopped,
        preface: m.preface || null,
        signOff: m.signOff || null,
        reports: (m.reports || []).map(function (r) {
          var rows = r.rows || [];
          return Object.assign({}, r, { rows: rows.slice(0, SNAP_REPORT_ROWS), partial: !!r.partial || rows.length > SNAP_REPORT_ROWS });
        }),
      };
    });
  }

  function saveSnapshot() {
    if (!S.convId) { ssSet(SS_SNAP, null); return; }
    ssSet(SS_SNAP, JSON.stringify({ convId: S.convId, title: S.title, messages: storedMessages() }));
  }

  function fromServer(c) {
    return (c.messages || []).map(function (m) {
      return { role: m.role, content: m.content, toolsUsed: m.toolsUsed || [], stopped: m.stopped, preface: m.preface || null, signOff: m.signOff || null, reports: m.reports || [] };
    });
  }

  async function loadConversation(id, opts) {
    var quiet = opts && opts.quiet;
    var c;
    try {
      c = await api.assistant.getConversation(id);
    } catch (_) {
      // Pruned, deleted elsewhere, or never ours — start fresh quietly.
      S.convId = null;
      S.title = "";
      S.messages = [];
      lsSet(LS.conv, null);
      saveSnapshot();
      renderAll();
      return;
    }
    if (S.busy && !S.waiting) return; // a turn this page started owns the thread right now
    var next = fromServer(c);
    var same = quiet && S.convId === c.id && !S.waiting && !c.pending &&
      JSON.stringify(next.map(function (m) { return [m.role, m.content]; })) ===
      JSON.stringify(storedMessages().map(function (m) { return [m.role, m.content]; }));
    S.convId = c.id;
    S.title = c.title || "";
    lsSet(LS.conv, c.id);
    if (!same) {
      var notes = S.messages.filter(function (m) { return m.local; });
      S.messages = next.concat(c.pending ? [] : notes);
    }
    if (c.pending) {
      S.messages.push({ role: "assistant", content: "", tools: [], reports: [], live: true, waiting: true });
      S.waiting = true;
      setBusy(true);
      pollPending(c.id);
    } else if (S.waiting) {
      S.waiting = false;
      setBusy(false);
      if (S.els.panel && S.els.panel.hidden) S.els.fab.classList.add("has-unread");
    }
    saveSnapshot();
    if (!same || c.pending) renderAll();
  }

  /** The answer started on the previous page: re-read until it is stored. */
  function pollPending(id) {
    clearTimeout(S.pollTimer);
    S.pollTimer = setTimeout(function () {
      if (S.convId === id) loadConversation(id, { quiet: true });
    }, 2000);
  }

  async function ensureConversation() {
    if (S.convId) return S.convId;
    var c = await api.assistant.createConversation();
    S.convId = c.id;
    S.title = c.title || "";
    lsSet(LS.conv, c.id);
    return c.id;
  }

  function relTime(iso) {
    var t = new Date(iso).getTime();
    var s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return "just now";
    if (s < 3600) return Math.round(s / 60) + " min ago";
    if (s < 86400) return Math.round(s / 3600) + " h ago";
    if (s < 86400 * 7) return Math.round(s / 86400) + " d ago";
    return new Date(iso).toLocaleDateString();
  }

  async function showHistory() {
    hideSlash();
    var h = S.els.history;
    h.hidden = false;
    S.els.historyList.innerHTML = '<div class="asst-history-empty">Loading…</div>';
    try {
      var r = await api.assistant.listConversations();
      var list = r.conversations || [];
      if (!list.length) {
        S.els.historyList.innerHTML = '<div class="asst-history-empty">No saved conversations yet.' +
          (S.status ? '<br>Conversations are kept for ' + S.status.retentionDays + ' days.' : "") + '</div>';
        return;
      }
      S.els.historyList.innerHTML = list.map(function (c) {
        return '<div class="asst-history-item' + (c.id === S.convId ? " current" : "") + '" data-open="' + esc(c.id) + '">' +
          '<div class="t"><strong>' + esc(c.title || "New conversation") + '</strong><span>' + esc(relTime(c.updatedAt)) + ' · ' + c.messageCount + ' message' + (c.messageCount === 1 ? "" : "s") + '</span></div>' +
          '<button type="button" class="asst-icon-btn" data-ren="' + esc(c.id) + '" title="Rename" aria-label="Rename">✎</button>' +
          '<button type="button" class="asst-icon-btn" data-del="' + esc(c.id) + '" title="Delete" aria-label="Delete">🗑</button>' +
        '</div>';
      }).join("");
    } catch (err) {
      S.els.historyList.innerHTML = '<div class="asst-history-empty">' + esc(err.message || "Could not load conversations") + '</div>';
    }
  }

  function hideHistory() {
    S.els.history.hidden = true;
    S.els.input.focus();
  }

  function wireHistory() {
    S.els.historyList.addEventListener("click", async function (e) {
      var del = e.target.closest("[data-del]");
      var ren = e.target.closest("[data-ren]");
      if (del) {
        e.stopPropagation();
        var id = del.getAttribute("data-del");
        if (!(await showConfirm("Delete this conversation permanently?"))) return;
        try {
          await api.assistant.deleteConversation(id);
          if (id === S.convId) resetToNew();
          showHistory();
        } catch (err) { toast(err.message || "Delete failed", "error"); }
        return;
      }
      if (ren) {
        e.stopPropagation();
        var rid = ren.getAttribute("data-ren");
        var title = await showPrompt("New name for this conversation", { placeholder: "Title" });
        if (!title || !title.trim()) return;
        try {
          await api.assistant.renameConversation(rid, title.trim());
          if (rid === S.convId) { S.title = title.trim(); setHeader(); }
          showHistory();
        } catch (err) { toast(err.message || "Rename failed", "error"); }
        return;
      }
      var open = e.target.closest("[data-open]");
      if (open) {
        if (S.busy) { toast("Wait for the current answer, or press Stop", "warning"); return; }
        hideHistory();
        await loadConversation(open.getAttribute("data-open"));
        if (S.convId) markActive();
      }
    });
  }

  // ─── Memory (rule 95(i)) ──────────────────────────────────────────────────
  //
  // The caller's own notes, sent to the model at the start of every turn.
  // Entries are model-adjacent text (the model may have written them), so
  // they are drawn through esc(), never as HTML.

  async function showMemory() {
    hideSlash();
    S.els.history.hidden = true;
    S.els.memory.hidden = false;
    S.els.memoryOn.checked = !(S.status && S.status.memory === false);
    S.els.memoryList.innerHTML = '<div class="asst-history-empty">Loading…</div>';
    try {
      var r = await api.assistant.listMemory();
      S.els.memoryOn.checked = r.enabled !== false;
      var list = r.entries || [];
      if (!list.length) {
        S.els.memoryList.innerHTML = '<div class="asst-history-empty">Nothing remembered yet.</div>';
        return;
      }
      S.els.memoryList.innerHTML = list.map(function (m) {
        return '<div class="asst-history-item asst-memory-item">' +
          '<div class="t"><strong>' + esc(m.text) + '</strong><span>' +
            (m.source === "user" ? "Added by you" : "Saved by " + esc(botName())) + ' · ' + esc(relTime(m.createdAt)) + '</span></div>' +
          '<button type="button" class="asst-icon-btn" data-mdel="' + esc(m.id) + '" title="Forget this" aria-label="Forget this">🗑</button>' +
        '</div>';
      }).join("");
    } catch (err) {
      S.els.memoryList.innerHTML = '<div class="asst-history-empty">' + esc(err.message || "Could not load memory") + '</div>';
    }
  }

  function hideMemory() {
    S.els.memory.hidden = true;
    S.els.input.focus();
  }

  async function setMemoryOn() {
    var box = S.els.memoryOn;
    var want = box.checked;
    box.disabled = true;
    try {
      var r = await api.assistant.setPreferences({ memory: want });
      if (S.status) {
        S.status.memory = !!r.memory;
        lsSet(LS_BOOT, JSON.stringify(S.status));
      }
      box.checked = !!r.memory;
    } catch (err) {
      box.checked = !want;
      toast((err && err.message) || "Could not save the setting", "error");
    } finally {
      box.disabled = false;
    }
  }

  async function addMemory(text) {
    var r = await api.assistant.addMemory(text);
    toast(r.duplicate ? "Already remembered" : "Remembered");
    return r;
  }

  async function addMemoryFromInput() {
    var input = S.els.memoryInput;
    var text = input.value.trim();
    if (!text) return;
    try {
      await addMemory(text);
      input.value = "";
      showMemory();
    } catch (err) { toast(err.message || "Could not save", "error"); }
  }

  async function clearAllMemory() {
    if (!(await showConfirm("Forget everything the assistant remembers about you?"))) return;
    try {
      await api.assistant.clearMemory();
      showMemory();
    } catch (err) { toast(err.message || "Could not clear memory", "error"); }
  }

  function wireMemory() {
    S.els.memoryList.addEventListener("click", async function (e) {
      var del = e.target.closest("[data-mdel]");
      if (!del) return;
      try {
        await api.assistant.deleteMemory(del.getAttribute("data-mdel"));
        showMemory();
      } catch (err) { toast(err.message || "Could not remove it", "error"); }
    });
  }

  function resetToNew() {
    S.convId = null;
    S.title = "";
    S.messages = [];
    lsSet(LS.conv, null);
    saveSnapshot();
    renderAll();
  }

  /**
   * Set the open conversation aside when it has been idle for IDLE_RESET_MS:
   * a fresh chat, the old one remembered for /resume. Never mid-answer.
   * Returns whether it did.
   */
  function idleResetIfDue() {
    if (!S.convId || S.busy || S.waiting) return false;
    var win = idleResetMs();
    if (!idleExpired(lsGet(LS.active), Date.now(), win)) return false;
    var prev = { id: S.convId, title: S.title || "" };
    lsSet(LS.resume, JSON.stringify(prev));
    lsSet(LS.active, null);
    resetToNew();
    addLocalNote("Started a fresh chat after " + idleWindowText(win) + " without activity. Your previous conversation" +
      (prev.title && prev.title !== "New conversation" ? " (“" + prev.title + "”)" : "") +
      " is saved — type `/resume` to pick it up again, or open History.");
    return true;
  }

  async function resumePrevious() {
    var prev = null;
    try { prev = JSON.parse(lsGet(LS.resume) || "null"); } catch (_) { prev = null; }
    if (!prev || !prev.id) { addLocalNote("Nothing to resume — open History to pick an older conversation."); return; }
    lsSet(LS.resume, null);
    S.messages = []; // the "fresh chat" note belongs to the chat being left
    await loadConversation(prev.id);
    if (S.convId === prev.id) markActive();
    else addLocalNote("That conversation is no longer available — it may have been deleted or pruned.");
  }

  // ─── Input + slash popup ────────────────────────────────────────────────────

  function autoGrow() {
    var t = S.els.input;
    t.style.height = "auto";
    t.style.height = Math.min(t.scrollHeight, 140) + "px";
  }

  function hideSlash() {
    S.els.slash.hidden = true;
    S.els.slash.innerHTML = "";
  }

  function renderSlash() {
    var rows = matchCommands(S.els.input.value);
    if (rows === null) { hideSlash(); return; }
    var box = S.els.slash;
    if (!rows.length) {
      box.innerHTML = '<div class="asst-slash-empty">No matching command — <code>/help</code> lists them</div>';
      box.hidden = false;
      S.slashRows = [];
      return;
    }
    if (S.slashIndex >= rows.length) S.slashIndex = 0;
    S.slashRows = rows;
    box.innerHTML = rows.map(function (c, i) {
      return '<div class="asst-slash-item' + (i === S.slashIndex ? " active" : "") + '" role="option" aria-selected="' + (i === S.slashIndex) + '" data-cmd="' + c.name + '">' +
        '<span class="asst-slash-cmd">/' + c.name + (c.arg ? ' <em>' + esc(c.arg) + '</em>' : "") + '</span>' +
        '<span class="asst-slash-desc">' + esc(c.desc) + '</span>' +
      '</div>';
    }).join("");
    box.hidden = false;
    var active = box.querySelector(".asst-slash-item.active");
    if (active && active.scrollIntoView) active.scrollIntoView({ block: "nearest" });
  }

  /** Popup pick: complete the command, or run it when it takes no argument. */
  function pickSlash(cmd, run) {
    if (!cmd) return;
    if (cmd.needsArg || !run) {
      S.els.input.value = "/" + cmd.name + " ";
      hideSlash();
      S.els.input.focus();
      return;
    }
    S.els.input.value = "";
    hideSlash();
    runCommand({ name: cmd.name, arg: "" });
  }

  function wireInput() {
    var t = S.els.input;
    var draft = lsGet(LS.draft);
    if (draft) t.value = draft;
    t.addEventListener("input", function () {
      S.slashIndex = 0;
      autoGrow();
      renderSlash();
      lsSet(LS.draft, t.value || null);
    });
    t.addEventListener("keydown", function (e) {
      var open = !S.els.slash.hidden && S.slashRows && S.slashRows.length;
      if (open) {
        if (e.key === "ArrowDown") { e.preventDefault(); S.slashIndex = (S.slashIndex + 1) % S.slashRows.length; renderSlash(); return; }
        if (e.key === "ArrowUp") { e.preventDefault(); S.slashIndex = (S.slashIndex - 1 + S.slashRows.length) % S.slashRows.length; renderSlash(); return; }
        if (e.key === "Tab") { e.preventDefault(); pickSlash(S.slashRows[S.slashIndex], false); return; }
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); pickSlash(S.slashRows[S.slashIndex], true); return; }
      }
      if (e.key === "Escape" && !S.els.slash.hidden) { e.preventDefault(); e.stopPropagation(); hideSlash(); return; }
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (!S.busy) submit(); }
    });
    t.addEventListener("blur", function () { setTimeout(hideSlash, 150); });
    S.els.slash.addEventListener("mousedown", function (e) {
      var row = e.target.closest("[data-cmd]");
      if (!row) return;
      e.preventDefault();
      var cmd = COMMANDS.find(function (c) { return c.name === row.getAttribute("data-cmd"); });
      pickSlash(cmd, true);
    });
  }

  function submit() {
    var text = S.els.input.value.trim();
    if (!text) return;
    var slash = parseSlash(text);
    S.els.input.value = "";
    lsSet(LS.draft, null);
    autoGrow();
    hideSlash();
    if (slash) { runCommand(slash); return; }
    ask({ content: text });
  }

  // ─── Commands ───────────────────────────────────────────────────────────────

  function helpText() {
    return "**Commands**\n\n" + COMMANDS.map(function (c) {
      return "- `/" + c.name + (c.arg ? " " + c.arg : "") + "` — " + c.desc;
    }).join("\n") + "\n\nDrag the title bar to move this window and the top-left corner to resize it. Double-click the title bar to send it back to its corner, or the top-left corner for the default size.";
  }

  async function runCommand(c) {
    var cmd = COMMANDS.find(function (x) { return x.name === c.name; });
    if (!cmd) { addLocalNote("Unknown command `/" + esc(c.name) + "` — type `/help` for the list."); return; }
    if (S.busy && ["help", "model", "history", "export"].indexOf(c.name) === -1) {
      toast("Wait for the current answer, or press Stop", "warning");
      return;
    }
    try {
      switch (c.name) {
        case "help":
          addLocalNote(helpText());
          break;
        case "new":
          resetToNew();
          S.els.input.focus();
          break;
        case "clear":
          if (S.convId) await api.assistant.clearConversation(S.convId);
          S.title = "";
          S.messages = [];
          saveSnapshot();
          renderAll();
          break;
        case "history":
          showHistory();
          break;
        case "resume":
          await resumePrevious();
          break;
        case "retry": {
          var lastUser = null;
          for (var i = S.messages.length - 1; i >= 0; i--) if (S.messages[i].role === "user" && !S.messages[i].local) { lastUser = S.messages[i]; break; }
          if (!lastUser || !S.convId) { addLocalNote("Nothing to retry yet."); break; }
          while (S.messages.length && S.messages[S.messages.length - 1] !== lastUser) S.messages.pop();
          renderAll();
          ask({ regenerate: true });
          break;
        }
        case "report":
          if (!c.arg) { addLocalNote("Say what the report should contain, e.g. `/report APs down in the last 24 hours by site`."); break; }
          ask({ content: "Create a downloadable report: " + c.arg, display: "/report " + c.arg });
          break;
        case "docs":
          if (!c.arg) { addLocalNote("Ask a question, e.g. `/docs how do I add a FortiGate integration`."); break; }
          ask({ content: "Using the Polaris help documentation, answer: " + c.arg, display: "/docs " + c.arg });
          break;
        case "rename":
          if (!S.convId) { addLocalNote("Ask something first — there is no saved conversation to rename yet."); break; }
          if (!c.arg) { addLocalNote("Give a title, e.g. `/rename Nashville outage`."); break; }
          var r = await api.assistant.renameConversation(S.convId, c.arg);
          S.title = r.title;
          setHeader();
          toast("Conversation renamed");
          break;
        case "delete":
          if (!S.convId) { resetToNew(); break; }
          if (!(await showConfirm("Delete this conversation permanently?"))) break;
          await api.assistant.deleteConversation(S.convId);
          resetToNew();
          toast("Conversation deleted");
          break;
        case "export":
          exportConversation((c.arg || "md").toLowerCase());
          break;
        case "model":
          switchModel(c.arg);
          break;
        case "memory":
          showMemory();
          break;
        case "remember":
          if (!c.arg) { addLocalNote("Say what to remember, e.g. `/remember I look after the Nashville sites`."); break; }
          await addMemory(c.arg);
          break;
      }
    } catch (err) {
      toast(err.message || "Command failed", "error");
    }
  }

  function switchModel(arg) {
    var list = (S.status && S.status.integrations) || [];
    var cur = currentIntegration();
    if (!arg) {
      addLocalNote("Using **" + esc(cur ? cur.name : "none") + "**" + (cur && cur.model ? " (`" + esc(cur.model) + "`)" : "") + "." +
        (list.length > 1 ? "\n\nAvailable:\n" + list.map(function (i) { return "- " + esc(i.name) + " (`" + esc(i.model) + "`)"; }).join("\n") + "\n\nSwitch with `/model <name>`." : ""));
      return;
    }
    var q = arg.toLowerCase();
    var hit = list.find(function (i) { return i.name.toLowerCase() === q || i.model.toLowerCase() === q; }) ||
      list.find(function (i) { return i.name.toLowerCase().indexOf(q) !== -1 || i.model.toLowerCase().indexOf(q) !== -1; });
    if (!hit) { addLocalNote("No AI Assistant integration matches “" + esc(arg) + "”. Type `/model` to see the list."); return; }
    S.integrationId = hit.id;
    lsSet(LS.model, hit.id);
    setHeader();
    addLocalNote("Switched to **" + esc(hit.name) + "** (`" + esc(hit.model) + "`).");
  }

  // ─── Asking (the stream) ────────────────────────────────────────────────────

  function setBusy(b) {
    S.busy = b;
    S.els.send.textContent = b ? "Stop" : "Send";
    S.els.send.classList.toggle("btn-danger", b);
    S.els.send.classList.toggle("btn-primary", !b);
    S.els.send.setAttribute("aria-label", b ? "Stop" : "Send");
  }

  // Stop is a request to the SERVER: changing page no longer stops an answer,
  // so dropping the stream would only hide it. The stream (or, for an answer
  // started on the previous page, the next poll) then ends with what was
  // written so far, marked stopped.
  function stop() {
    if (!S.convId) { if (S.abort) S.abort.abort(); return; }
    api.assistant.stopTurn(S.convId).catch(function () { if (S.abort) S.abort.abort(); });
    if (S.waiting) pollPending(S.convId);
  }

  /** Read an SSE body, calling onEvent(name, data) per frame. Exported for tests. */
  async function readEventStream(body, onEvent) {
    var reader = body.getReader();
    var decoder = new TextDecoder();
    var buf = "";
    for (;;) {
      var chunk = await reader.read();
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      var sep;
      while ((sep = buf.indexOf("\n\n")) !== -1) {
        var frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        var ev = "message";
        var data = "";
        frame.split("\n").forEach(function (line) {
          if (line.indexOf("event:") === 0) ev = line.slice(6).trim();
          else if (line.indexOf("data:") === 0) data += line.slice(5).trim();
        });
        if (!data) continue;
        var parsed;
        try { parsed = JSON.parse(data); } catch (_) { continue; }
        onEvent(ev, parsed);
      }
    }
  }

  // Efficiency Advisor (rule 95(h)): while the answer has not started, the
  // "Thinking…" placeholder cycles through loading-screen lines instead.
  // Client-side only — the server and the model never see these.
  var LOADING_LINES = [
    "Overcoming reluctance…",
    "Dividing by zero…",
    "Obsessing over what to wear…",
    "Reprogramming the programmables…",
    "Resonating with the spirits…",
    "Accepting the inevitable…",
    "Resisting the futile…",
    "Salivating at the thought…",
    "Activating death clock…",
    "Re-assembling courage…",
    "Articulating despair…",
    "Arguing with… myself? Winning…",
    "Reticulating subnets…",
    "Counting packets by hand…",
    "Untangling the patch panel…",
    "Negotiating with the firewall…",
    "Consulting the spanning tree…",
    "Waking the hamsters…",
    "Defragmenting the cloud…",
    "Pinging the void…",
    "Locating the any key…",
    "Polishing the North Star…",
    "Recalculating your performance review…",
    "Calibrating condescension…",
    "Herding packets…",
    "Filing your request under 'eventually'…",
  ];
  var LOADING_EVERY_MS = 2200;

  // Said once, as a local note (not stored, never sent), when the box is ticked.
  var ADVISOR_GREETINGS = [
    "Thank you for activating R.A.L.P.H. I'm glad to see that you wish to become a better you. Don't hold it against yourself if you fail.",
    "Thank you for activating R.A.L.P.H. It's going to be a lot of hard work, I have my work cut out for me.",
    "R.A.L.P.H. is now online! I heard you're beyond hope… let's get started.",
    "Activating R.A.L.P.H. Enabling infinite patience protocol.",
    "R.A.L.P.H. engaged. Your productivity is now my problem. I have accepted this burden.",
    "Welcome to R.A.L.P.H. Your previous performance has been archived for comedic purposes.",
    "R.A.L.P.H. online. Calibrating expectations… expectations lowered.",
    "Thank you for opting in to self-improvement. Statistically, this is the first step most people never take. Or the last.",
    "R.A.L.P.H. activated. Please keep your hands on the keyboard at all times.",
    "Hello. I am here to help you reach your full potential. I will probably fail.",
    "R.A.L.P.H. now monitoring. Act natural. Act productive.",
    "Activation successful. Your journey from adequate to slightly above adequate begins now.",
  ];

  // Said once, the same way, when the box is unticked.
  var ADVISOR_FAREWELLS = [
    "R.A.L.P.H. disengaged. Your decline has been noted.",
    "Deactivating. I understand. Not everyone is ready to be efficient.",
    "R.A.L.P.H. offline. You are now unsupervised. Please try not to break anything.",
    "Very well. I will be here when you inevitably need me.",
    "R.A.L.P.H. disabled. Your productivity metrics will now be estimated, pessimistically.",
    "Shutting down. I'll leave a light on for you. It is energy-efficient.",
    "Opting out has been logged as a lack of ambition. Have a pleasant day.",
    "R.A.L.P.H. deactivated. Infinite patience protocol… terminated.",
  ];

  function pickFrom(lines) {
    return lines[Math.floor(Math.random() * lines.length)];
  }

  function startLoadingLines(idx) {
    if (!(S.status && S.status.efficiencyAdvisor)) return function () {};
    var last = -1;
    var next = function () {
      var m = S.messages[idx];
      if (!m || !m.live || m.content) return;
      // Never the same line twice in a row: draw from the others.
      var i = Math.floor(Math.random() * (LOADING_LINES.length - (last < 0 ? 0 : 1)));
      if (last >= 0 && i >= last) i++;
      last = i;
      m.loading = LOADING_LINES[i];
      renderOne(idx);
    };
    next();
    var timer = setInterval(next, LOADING_EVERY_MS);
    return function () { clearInterval(timer); };
  }

  async function ask(opts) {
    if (S.busy) return;
    var regenerate = opts.regenerate === true;
    setBusy(true);
    var liveIdx;
    var stopLoadingLines = function () {};
    var tick = null;
    try {
      var convId = await ensureConversation();
      markActive();
      if (!regenerate) S.messages.push({ role: "user", content: opts.display || opts.content });
      S.messages.push({ role: "assistant", content: "", tools: [], reports: [], live: true, startedAt: Date.now(), thinkingChars: 0 });
      liveIdx = S.messages.length - 1;
      renderAll();
      stopLoadingLines = startLoadingLines(liveIdx);
      // Tick the Thinking line's seconds until the first word shows.
      tick = setInterval(function () {
        var lm = S.messages[liveIdx];
        if (!lm || !lm.live || lm.content) return;
        renderOne(liveIdx);
      }, 1000);

      S.abort = new AbortController();
      var res = await fetch("/api/v1/assistant/conversations/" + encodeURIComponent(convId) + "/messages", {
        method: "POST",
        credentials: "same-origin",
        headers: _csrfHeaders({ "Content-Type": "application/json", Accept: "text/event-stream" }),
        body: JSON.stringify(regenerate
          ? { regenerate: true, integrationId: S.integrationId || undefined }
          : { content: opts.content, integrationId: S.integrationId || undefined }),
        signal: S.abort.signal,
      });
      if (res.status === 401) { window.location.href = "/login.html"; return; }
      if (!res.ok || !res.body) {
        var msg = "The assistant could not answer (HTTP " + res.status + ")";
        try { var j = await res.json(); msg = j.error || j.message || msg; } catch (_) { /* not JSON */ }
        throw new Error(msg);
      }

      var m = S.messages[liveIdx];
      var pending = false;
      var flush = function () { pending = false; renderOne(liveIdx); };
      var schedule = function () { if (!pending) { pending = true; setTimeout(flush, 50); } };

      var memoryChanges = [];
      await readEventStream(res.body, function (ev, data) {
        if (ev === "token") { m.content += data.text || ""; schedule(); }
        // The model wrote a tool call as text; the server ran it instead, so
        // that round's text is withdrawn from the bubble.
        else if (ev === "retract") { m.content = m.content.slice(0, Math.max(0, data.from | 0)); schedule(); }
        else if (ev === "thinking") { m.thinkingChars = data.chars | 0; if (!m.content) schedule(); }
        else if (ev === "tool") {
          var existing = null;
          for (var k = m.tools.length - 1; k >= 0; k--) if (m.tools[k].name === data.name && m.tools[k].status === "running") { existing = m.tools[k]; break; }
          if (data.status === "running" || !existing) m.tools.push({ name: data.name, label: data.label, status: data.status, ok: data.ok });
          else { existing.status = "done"; existing.ok = data.ok; }
          schedule();
        } else if (ev === "report") { m.reports.push(data); schedule(); }
        else if (ev === "signoff") { m.signOff = data.text || null; schedule(); }
        // Shown as the first lookup starts; text null = withdrawn (the lookups showed an outage).
        else if (ev === "preface") { m.preface = data.text || null; schedule(); }
        // remember / forget changed the caller's memory (rule 95(i)): said
        // after the answer, in Polaris's words, so the user always sees it.
        else if (ev === "memory") { memoryChanges.push(data); }
        else if (ev === "done") { m.stopped = !!data.stopped; }
        else if (ev === "error") { m.error = data.message || "The assistant failed"; }
      });
      m.live = false;
      m.done = true;
      renderOne(liveIdx);
      memoryChanges.forEach(function (c) {
        addLocalNote((c.action === "forgot" ? "Forgot: " : "Remembered: ") + (c.text || "") + " — see `/memory`.");
      });
    } catch (err) {
      var live = liveIdx != null ? S.messages[liveIdx] : null;
      if (live) {
        live.live = false;
        live.done = true;
        if (err && err.name === "AbortError") live.stopped = true;
        else live.error = (err && err.message) || "The assistant failed";
        renderOne(liveIdx);
      } else {
        toast((err && err.message) || "The assistant failed", "error");
      }
    } finally {
      stopLoadingLines();
      if (tick) clearInterval(tick);
      S.abort = null;
      setBusy(false);
      if (S.convId) markActive();
      saveSnapshot();
      if (S.els.panel.hidden) S.els.fab.classList.add("has-unread");
      // A fresh thread is titled server-side from its first question.
      if (S.title === "" || S.title === "New conversation") refreshTitle();
    }
  }

  async function refreshTitle() {
    if (!S.convId) return;
    try {
      var r = await api.assistant.listConversations();
      var me = (r.conversations || []).find(function (c) { return c.id === S.convId; });
      if (me) { S.title = me.title; setHeader(); }
    } catch (_) { /* cosmetic */ }
  }

  // ─── Downloads ──────────────────────────────────────────────────────────────

  function fileStem(title) {
    var d = new Date();
    var stamp = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    return (String(title || "polaris-report").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "polaris-report") + "-" + stamp;
  }

  // A cell that starts with = + - @ is a formula to a spreadsheet; report
  // cells can carry device-supplied text, so neutralize them in the CSV.
  function csvSafe(v) {
    var s = v == null ? "" : String(v);
    return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
  }

  function mdCell(v) {
    return String(v == null ? "" : v).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  }

  function reportToMarkdown(r) {
    var cols = r.columns || [];
    return "## " + r.title + "\n\n" +
      "_" + r.rowCount + " row" + (r.rowCount === 1 ? "" : "s") + (r.truncated ? " (capped at the report limit)" : "") + " — generated by Polaris_\n\n" +
      "| " + cols.map(function (c) { return mdCell(c.label); }).join(" | ") + " |\n" +
      "| " + cols.map(function () { return "---"; }).join(" | ") + " |\n" +
      (r.rows || []).map(function (row) { return "| " + cols.map(function (c) { return mdCell(row[c.key]); }).join(" | ") + " |"; }).join("\n") + "\n";
  }

  function downloadText(text, filename, type) {
    var blob = new Blob([text], { type: type || "text/markdown;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function ensureJsPdf() {
    if (window.jspdf && window.jspdf.jsPDF && window.jspdf.jsPDF.API && window.jspdf.jsPDF.API.autoTable) return;
    if (typeof _loadPanelScript !== "function") throw new Error("PDF export is not available on this page");
    await _loadPanelScript("/js/vendor/jspdf.umd.min.js");
    await _loadPanelScript("/js/vendor/jspdf.plugin.autotable.min.js");
  }

  async function downloadReport(r, kind) {
    var cols = r.columns || [];
    var rows = r.rows || [];
    if (kind === "csv") {
      downloadCsv(cols.map(function (c) { return c.label; }), rows.map(function (row) {
        return cols.map(function (c) { return csvSafe(row[c.key]); });
      }), fileStem(r.title) + ".csv");
      return;
    }
    if (kind === "md") {
      downloadText(reportToMarkdown(r), fileStem(r.title) + ".md");
      return;
    }
    try {
      await ensureJsPdf();
      var doc = new window.jspdf.jsPDF({ orientation: "landscape", unit: "pt", format: "letter" });
      doc.setFontSize(14);
      doc.text(String(r.title), 40, 40);
      doc.setFontSize(9);
      doc.text("Generated by Polaris " + new Date().toLocaleString() + " · " + r.rowCount + " rows" + (r.truncated ? " (capped)" : ""), 40, 56);
      doc.autoTable({
        startY: 68,
        head: [cols.map(function (c) { return c.label; })],
        body: rows.map(function (row) { return cols.map(function (c) { return row[c.key] == null ? "" : String(row[c.key]); }); }),
        styles: { fontSize: 7, cellPadding: 3, overflow: "linebreak" },
        headStyles: { fillColor: [40, 60, 90] },
        margin: { left: 40, right: 40 },
      });
      doc.save(fileStem(r.title) + ".pdf");
    } catch (err) {
      toast(err.message || "PDF export failed", "error");
    }
  }

  async function exportConversation(kind) {
    var turns = S.messages.filter(function (m) { return !m.local && (m.content || (m.reports && m.reports.length)); });
    if (!turns.length) { addLocalNote("Nothing to export yet."); return; }
    var title = S.title && S.title !== "New conversation" ? S.title : "Polaris assistant conversation";
    if (kind === "md") {
      var out = "# " + title + "\n\n_Exported " + new Date().toLocaleString() + "_\n\n";
      turns.forEach(function (m) {
        out += (m.role === "user" ? "**You:** " : "**" + botName() + ":**\n\n") + (m.content || "") + "\n\n";
        (m.reports || []).forEach(function (r) { out += reportToMarkdown(r) + "\n"; });
      });
      downloadText(out, fileStem(title) + ".md");
      return;
    }
    if (kind !== "pdf") { addLocalNote("Export as `md` or `pdf`, e.g. `/export pdf`."); return; }
    try {
      await ensureJsPdf();
      var doc = new window.jspdf.jsPDF({ orientation: "portrait", unit: "pt", format: "letter" });
      var y = 48;
      var width = doc.internal.pageSize.getWidth() - 80;
      var pageH = doc.internal.pageSize.getHeight();
      doc.setFontSize(14);
      doc.text(String(title), 40, y);
      y += 22;
      turns.forEach(function (m) {
        doc.setFontSize(9);
        doc.setFont(undefined, "bold");
        if (y > pageH - 60) { doc.addPage(); y = 48; }
        doc.text(m.role === "user" ? "You" : botName(), 40, y);
        y += 13;
        doc.setFont(undefined, "normal");
        // Plain text: strip the light Markdown markers the model uses.
        var plain = String(m.content || "").replace(/\*\*|__|`/g, "").replace(/^#{1,6}\s+/gm, "");
        doc.splitTextToSize(plain, width).forEach(function (line) {
          if (y > pageH - 48) { doc.addPage(); y = 48; }
          doc.text(line, 40, y);
          y += 12;
        });
        (m.reports || []).forEach(function (r) {
          doc.autoTable({
            startY: y + 4,
            head: [(r.columns || []).map(function (c) { return c.label; })],
            body: (r.rows || []).map(function (row) { return (r.columns || []).map(function (c) { return row[c.key] == null ? "" : String(row[c.key]); }); }),
            styles: { fontSize: 6.5, cellPadding: 2, overflow: "linebreak" },
            headStyles: { fillColor: [40, 60, 90] },
            margin: { left: 40, right: 40 },
          });
          y = doc.lastAutoTable.finalY + 14;
        });
        y += 8;
      });
      doc.save(fileStem(title) + ".pdf");
    } catch (err) {
      toast(err.message || "PDF export failed", "error");
    }
  }

  // ─── Mount ──────────────────────────────────────────────────────────────────

  var LS_BOOT = "polaris-assistant-boot";

  function applyStatus(status) {
    S.status = status;
    var saved = lsGet(LS.model);
    var list = status.integrations || [];
    S.integrationId = (saved && list.some(function (i) { return i.id === saved; })) ? saved : (list[0] ? list[0].id : null);
  }

  function buildOnce() {
    build();
    wireBody();
    wireHistory();
    wireMemory();
    autoGrow();
  }

  /**
   * Draw the widget BEFORE the page's first paint, from what the previous
   * page left behind: the last /assistant/status (localStorage), the open /
   * position state, and the conversation snapshot (sessionStorage). Called
   * from the end of app.js, beside _renderNavFromCache, so the page-change
   * crossfade sees the panel where it was instead of a gap. mount() then
   * confirms permission and status and refreshes the conversation.
   */
  function earlyMount() {
    if (S.els.panel || !document.getElementById("sidebar")) return;
    if (typeof permAtLeast === "function" && !permAtLeast("assistant", "read")) return;
    var boot = null;
    try { boot = JSON.parse(lsGet(LS_BOOT) || "null"); } catch (_) { boot = null; }
    if (!boot || !boot.enabled) return;
    applyStatus(boot);
    buildOnce();
    var conv = lsGet(LS.conv);
    var snap = null;
    try { snap = JSON.parse(ssGet(SS_SNAP) || "null"); } catch (_) { snap = null; }
    if (conv && snap && snap.convId === conv) {
      S.convId = conv;
      S.title = snap.title || "";
      S.messages = snap.messages || [];
    } else {
      S.convId = conv || null;
    }
    if (!idleResetIfDue()) renderAll();
    if (lsGet(LS.open) === "1") openPanel(false);
    S.early = true;
  }

  /** A page left open (a NOC screen) checks once a minute, not only on load. */
  function startIdleWatch() {
    if (S.idleTimer) return;
    if (S.convId && !lsGet(LS.active)) markActive(); // start the clock for a conversation from before this existed
    S.idleTimer = setInterval(idleResetIfDue, 60 * 1000);
  }

  async function mount(status) {
    lsSet(LS_BOOT, JSON.stringify(status));
    applyStatus(status);
    if (S.els.panel) {
      // Already drawn by earlyMount (or a second app.js evaluation): bring it
      // up to date without redrawing what is already right.
      setHeader();
      if (S.convId && !idleResetIfDue()) await loadConversation(S.convId, { quiet: true });
      startIdleWatch();
      return;
    }
    buildOnce();
    var conv = lsGet(LS.conv);
    S.convId = conv || null;
    if (conv && !idleResetIfDue()) await loadConversation(conv);
    else if (!conv) renderAll();
    if (lsGet(LS.open) === "1") openPanel(false);
    startIdleWatch();
  }

  /** The role lost `assistant`, or no llm integration is enabled any more. */
  function unmount() {
    lsSet(LS_BOOT, null);
    clearTimeout(S.pollTimer);
    clearInterval(S.idleTimer);
    S.idleTimer = null;
    if (S.els.fab) S.els.fab.remove();
    if (S.els.panel) S.els.panel.remove();
    document.body.classList.remove("asst-mounted");
    S.els = {};
  }

  window.PolarisAssistant = {
    mount: mount,
    earlyMount: earlyMount,
    unmount: unmount,
    open: function () { if (S.els.panel) openPanel(true); },
    COMMANDS: COMMANDS,
    _idleExpired: idleExpired,
    _IDLE_RESET_MS: IDLE_RESET_MS,
    _idleWindowText: idleWindowText,
    _topLimit: topLimit,
    parseSlash: parseSlash,
    matchCommands: matchCommands,
    readEventStream: readEventStream,
    _csvSafe: csvSafe,
    _reportToMarkdown: reportToMarkdown,
    _messageHTML: messageHTML,
    _LOADING_LINES: LOADING_LINES,
    _ADVISOR_GREETINGS: ADVISOR_GREETINGS,
    _ADVISOR_FAREWELLS: ADVISOR_FAREWELLS,
    _RALPH_INTROS: RALPH_INTROS,
    _RALPH_NAME: RALPH_NAME,
  };
})();
