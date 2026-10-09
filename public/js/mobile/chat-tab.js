// public/js/mobile/chat-tab.js — the AI assistant on the phone (business rule 95).
//
// The same assistant as the desktop's floating window, as a navbar tab: the
// same saved conversations (owner-only, server side), the same streamed ask
// (POST /assistant/conversations/:id/messages, read as server-sent events by
// PolarisAssistant.readEventStream), the same report downloads, and the same
// 30-minute "fresh chat, /resume to go back" rule, sharing the desktop's
// localStorage keys so a phone browser that also opens the desktop page sees
// one current conversation, not two.
//
// What the phone leaves out: the slash-command popup (only /new and /resume
// are understood here; the History and New buttons cover the rest), PDF
// export, the model picker, and the advisor's client-side loading lines. The
// R.A.L.P.H. button is here (the same per-user switch as the desktop's), and
// on open the tab continues the conversation the person was active in on ANY
// device inside the idle window, so a phone picks up a desktop chat. Lookups
// always run as the signed-in user (rule 95(a)).
//
// Everything a model wrote is rendered through PolarisMarkdown, which escapes
// first; everything else goes through escapeHtml.

(function () {
  var LS = {
    conv: "polaris-assistant-conv",
    active: "polaris-assistant-active",
    resume: "polaris-assistant-resume",
  };
  function lsGet(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
  function lsSet(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (_) { /* private mode */ } }

  var S = {
    status: null,       // GET /assistant/status, once per page load
    convId: null,
    title: "",
    messages: [],       // { role, content, toolsUsed|tools, reports, preface, signOff, error, live, local }
    busy: false,
    abort: null,
    pollTimer: null,
    body: null,         // the .app-body this tab last rendered into
  };

  function A() { return window.PolarisAssistant || {}; }
  function md(s) { return window.PolarisMarkdown ? PolarisMarkdown.render(s) : escapeHtml(s); }
  function snack(msg, opts) { if (window.PolarisTabs) PolarisTabs.showSnackbar(msg, opts); }
  function markActive() { lsSet(LS.active, String(Date.now())); }
  function onThisTab() { return S.body && document.body.contains(S.body) && document.getElementById("chat-log"); }

  // ─── Rendering ─────────────────────────────────────────────────────────
  function chipHTML(t) {
    var cls = t.status === "running" ? " running" : t.ok === false ? " failed" : "";
    return '<span class="chat-chip' + cls + '">' + escapeHtml(t.label || t.name) + '</span>';
  }

  function reportHTML(r, ri, mi) {
    return ''
      + '<div class="chat-report">'
      + '  <div class="chat-report-title">' + escapeHtml(r.title || "Report") + '</div>'
      + '  <div class="chat-report-meta">' + (r.rowCount | 0) + ' row' + (r.rowCount === 1 ? '' : 's') + (r.truncated ? ' · capped' : '') + '</div>'
      + '  <div class="chat-report-actions">'
      + '    <button class="btn-tonal" data-dl="csv" data-m="' + mi + '" data-i="' + ri + '">CSV</button>'
      + '    <button class="btn-tonal" data-dl="md" data-m="' + mi + '" data-i="' + ri + '">Markdown</button>'
      + '  </div>'
      + '</div>';
  }

  function messageHTML(m, i) {
    if (m.local) return '<div class="chat-msg assistant"><div class="chat-bubble local">' + md(m.content) + '</div></div>';
    if (m.role === "user") return '<div class="chat-msg user"><div class="chat-bubble">' + escapeHtml(m.content) + '</div></div>';
    var text = m.content ? md(m.content)
      : m.waiting ? '<span class="chat-thinking">Still answering your last question…</span>'
      : (m.live && !m.error ? '<span class="chat-thinking">Thinking…</span>' : "");
    var chips = (m.tools || m.toolsUsed || []).map(chipHTML).join("") + (m.stopped ? '<span class="chat-chip failed">stopped</span>' : "");
    return '<div class="chat-msg assistant" data-idx="' + i + '">'
      + (m.preface ? '<div class="chat-aside">' + escapeHtml(m.preface) + '</div>' : "")
      + (text ? '<div class="chat-bubble">' + text + '</div>' : "")
      + (chips ? '<div class="chat-chips">' + chips + '</div>' : "")
      + (m.reports || []).map(function (r, ri) { return reportHTML(r, ri, i); }).join("")
      + (m.signOff ? '<div class="chat-aside">' + escapeHtml(m.signOff) + '</div>' : "")
      + (m.error ? '<div class="chat-error">' + escapeHtml(m.error) + '</div>' : "")
      + '</div>';
  }

  function emptyHTML() {
    if (ralphOn()) {
      var intros = A()._RALPH_INTROS || [];
      var quip = intros.length ? intros[Math.floor(Math.random() * intros.length)] : "";
      return ''
        + '<div class="empty-state" style="padding-top:32px;">'
        + '  <div class="icon"><svg viewBox="0 0 24 24"><use href="#i-chat"/></svg></div>'
        + '  <div class="ttl">I\'m R.A.L.P.H.</div>'
        + '  <div class="desc">Your Real-time Assesser of Labor and Productivity Habits. Ask about devices, alerts, networks and events — looked up with your own permissions.</div>'
        + (quip ? '  <div class="desc chat-aside" style="margin-top:8px;">' + escapeHtml(quip) + '</div>' : '')
        + '</div>';
    }
    var name = (S.status && S.status.integrations && S.status.integrations[0] && S.status.integrations[0].displayName) || "the assistant";
    return ''
      + '<div class="empty-state" style="padding-top:32px;">'
      + '  <div class="icon"><svg viewBox="0 0 24 24"><use href="#i-chat"/></svg></div>'
      + '  <div class="ttl">Ask ' + escapeHtml(name) + '</div>'
      + '  <div class="desc">Devices, alerts, networks and events — looked up with your own permissions. It only reads; it never changes anything.</div>'
      + '</div>';
  }

  function scrollToEnd() { if (S.body) S.body.scrollTop = S.body.scrollHeight; }

  function renderLog() {
    var log = document.getElementById("chat-log");
    if (!log) return;
    log.innerHTML = S.messages.length ? S.messages.map(messageHTML).join("") : emptyHTML();
    var btn = document.getElementById("chat-send");
    if (btn) {
      btn.setAttribute("aria-label", S.busy ? "Stop" : "Send");
      btn.innerHTML = '<svg viewBox="0 0 24 24"><use href="' + (S.busy ? "#i-stop" : "#i-send") + '"/></svg>';
    }
    var title = document.getElementById("chat-title");
    // R.A.L.P.H. owns the title while on; otherwise the conversation's title, else the assistant's name.
    if (title) title.textContent = !ralphOn() && S.title && S.title !== "New conversation" ? S.title : headerName();
    scrollToEnd();
  }

  function ralphOn() { return !!(S.status && S.status.efficiencyAdvisor); }

  // While R.A.L.P.H. is on the tab IS R.A.L.P.H., as on the desktop (botName).
  function headerName() {
    if (ralphOn()) return A()._RALPH_NAME || "R.A.L.P.H.";
    var i = S.status && S.status.integrations && S.status.integrations[0];
    return (i && i.displayName) || "Assistant";
  }

  function addLocalNote(text) {
    S.messages.push({ role: "assistant", content: text, local: true });
    if (onThisTab()) renderLog();
  }

  // ─── Conversations ─────────────────────────────────────────────────────
  function fromServer(c) {
    return (c.messages || []).map(function (m) {
      return { role: m.role, content: m.content, toolsUsed: m.toolsUsed || [], stopped: m.stopped, preface: m.preface || null, signOff: m.signOff || null, reports: m.reports || [] };
    });
  }

  function resetToNew() {
    S.convId = null; S.title = ""; S.messages = [];
    lsSet(LS.conv, null);
  }

  /** The integration's idle window in ms (idleResetMinutes, default 30); 0 = never set a chat aside. */
  function idleResetMs() {
    var i = S.status && S.status.integrations && S.status.integrations[0];
    var m = i && typeof i.idleResetMinutes === "number" ? i.idleResetMinutes : 30;
    return Math.max(0, m) * 60000;
  }

  /** The desktop's idle rule (assistant.js → idleResetIfDue), same keys, same window. */
  function idleResetIfDue() {
    if (!S.convId || S.busy) return false;
    var win = idleResetMs();
    var expired = A()._idleExpired ? A()._idleExpired(lsGet(LS.active), Date.now(), win) : false;
    if (!expired) return false;
    lsSet(LS.resume, JSON.stringify({ id: S.convId, title: S.title || "" }));
    lsSet(LS.active, null);
    resetToNew();
    var span = A()._idleWindowText ? A()._idleWindowText(win) : Math.round(win / 60000) + " minutes";
    addLocalNote("Started a fresh chat after " + span + " without activity. Your previous conversation is saved — type `/resume` to pick it up again, or open History.");
    return true;
  }

  /**
   * The person's most recently active conversation, when it was touched (on
   * any device) inside the idle window; null otherwise, or when the list
   * cannot be read. Exported for tests via the spec.
   */
  function latestActiveConversation() {
    var idleMs = idleResetMs() || Infinity; // 0 = never set aside, so any newer conversation is followed
    return api.assistant.listConversations().then(function (r) {
      var c = (r && r.conversations || [])[0];
      if (!c || !c.messageCount) return null;
      var at = Date.parse(c.updatedAt);
      var age = Date.now() - at;
      if (!(age >= 0 && age < idleMs)) return null;
      // This phone was used more recently than that conversation changed: a
      // chat reopened here on purpose stays put (the desktop's tiebreak too).
      if (c.id !== lsGet(LS.conv) && Number(lsGet(LS.active)) > at) return null;
      return c;
    }).catch(function () { return null; });
  }

  // ─── R.A.L.P.H. (the Efficiency Advisor) ──────────────────────────────
  // The same per-user switch as the desktop's button (PUT /assistant/
  // preferences), drawn the same way: a pill that glows while on.
  function showRalph(on) {
    var b = document.getElementById("chat-ralph-btn");
    if (!b) return;
    b.classList.toggle("on", !!on);
    b.setAttribute("aria-pressed", on ? "true" : "false");
  }

  function toggleRalph() {
    var b = document.getElementById("chat-ralph-btn");
    if (!b || b.disabled) return;
    var want = b.getAttribute("aria-pressed") !== "true";
    showRalph(want);
    b.disabled = true;
    api.assistant.setPreferences({ efficiencyAdvisor: want }).then(function (r) {
      var on = !!(r && r.efficiencyAdvisor);
      if (S.status) S.status.efficiencyAdvisor = on;
      showRalph(on);
      var lines = on ? A()._ADVISOR_GREETINGS : A()._ADVISOR_FAREWELLS;
      if (lines && lines.length) addLocalNote(lines[Math.floor(Math.random() * lines.length)]);
    }).catch(function (err) {
      showRalph(!want);
      snack((err && err.message) || "Could not save the setting", { error: true });
    }).then(function () { b.disabled = false; });
  }

  function loadConversation(id) {
    clearTimeout(S.pollTimer);
    return api.assistant.getConversation(id).then(function (c) {
      S.convId = c.id;
      S.title = c.title || "";
      lsSet(LS.conv, c.id);
      S.messages = fromServer(c);
      if (c.pending) {
        // A turn started elsewhere (or before a reload) is still running server side.
        S.messages.push({ role: "assistant", content: "", live: true, waiting: true });
        S.pollTimer = setTimeout(function () { if (S.convId === id && !S.busy) loadConversation(id); }, 2000);
      }
      if (onThisTab()) renderLog();
    }).catch(function () {
      // Pruned, deleted elsewhere, or never ours: start fresh quietly.
      resetToNew();
      if (onThisTab()) renderLog();
    });
  }

  function resumePrevious() {
    var prev = null;
    try { prev = JSON.parse(lsGet(LS.resume) || "null"); } catch (_) { prev = null; }
    if (!prev || !prev.id) { addLocalNote("Nothing to resume — open History to pick an older conversation."); return; }
    lsSet(LS.resume, null);
    S.messages = [];
    loadConversation(prev.id).then(function () { if (S.convId === prev.id) markActive(); });
  }

  // ─── Asking ────────────────────────────────────────────────────────────
  function ensureConversation() {
    if (S.convId) return Promise.resolve(S.convId);
    return api.assistant.createConversation().then(function (c) {
      S.convId = c.id; S.title = c.title || "";
      lsSet(LS.conv, c.id);
      return c.id;
    });
  }

  async function ask(content) {
    if (S.busy) return;
    S.busy = true;
    var m = null;
    try {
      var convId = await ensureConversation();
      markActive();
      S.messages.push({ role: "user", content: content });
      m = { role: "assistant", content: "", tools: [], reports: [], live: true };
      S.messages.push(m);
      renderLog();
      S.abort = new AbortController();
      var res = await fetch("/api/v1/assistant/conversations/" + encodeURIComponent(convId) + "/messages", {
        method: "POST",
        credentials: "same-origin",
        headers: _csrfHeaders({ "Content-Type": "application/json", Accept: "text/event-stream" }),
        body: JSON.stringify({ content: content }),
        signal: S.abort.signal,
      });
      if (!res.ok || !res.body) {
        var msg = "The assistant could not answer (HTTP " + res.status + ")";
        try { var j = await res.json(); msg = j.error || j.message || msg; } catch (_) { /* not JSON */ }
        throw new Error(msg);
      }
      var pending = false;
      var schedule = function () { if (!pending) { pending = true; setTimeout(function () { pending = false; if (onThisTab()) renderLog(); }, 60); } };
      await A().readEventStream(res.body, function (ev, data) {
        if (ev === "token") { m.content += data.text || ""; schedule(); }
        else if (ev === "retract") { m.content = m.content.slice(0, Math.max(0, data.from | 0)); schedule(); }
        else if (ev === "tool") {
          var cur = null;
          for (var k = m.tools.length - 1; k >= 0; k--) if (m.tools[k].name === data.name && m.tools[k].status === "running") { cur = m.tools[k]; break; }
          if (data.status === "running" || !cur) m.tools.push({ name: data.name, label: data.label, status: data.status, ok: data.ok });
          else { cur.status = "done"; cur.ok = data.ok; }
          schedule();
        }
        else if (ev === "report") { m.reports.push(data); schedule(); }
        else if (ev === "preface") { m.preface = data.text || null; schedule(); }
        else if (ev === "signoff") { m.signOff = data.text || null; schedule(); }
        else if (ev === "done") { m.stopped = !!data.stopped; }
        else if (ev === "error") { m.error = data.message || "The assistant failed"; }
      });
    } catch (err) {
      if (m) {
        if (err && err.name === "AbortError") m.stopped = true;
        else m.error = (err && err.message) || "The assistant failed";
      } else {
        snack((err && err.message) || "The assistant failed", { error: true });
      }
    } finally {
      if (m) m.live = false;
      S.busy = false;
      S.abort = null;
      if (S.convId) markActive();
      if (onThisTab()) renderLog();
      if (S.title === "" || S.title === "New conversation") refreshTitle();
    }
  }

  function refreshTitle() {
    if (!S.convId) return;
    api.assistant.listConversations().then(function (r) {
      var me = (r.conversations || []).find(function (c) { return c.id === S.convId; });
      if (me) { S.title = me.title; if (onThisTab()) renderLog(); }
    }).catch(function () { /* cosmetic */ });
  }

  function stop() {
    if (!S.convId) { if (S.abort) S.abort.abort(); return; }
    api.assistant.stopTurn(S.convId).catch(function () { if (S.abort) S.abort.abort(); });
  }

  function submit() {
    var input = document.getElementById("chat-input");
    if (!input) return;
    var text = input.value.trim();
    if (!text) return;
    var slash = A().parseSlash ? A().parseSlash(text) : null;
    if (slash) {
      input.value = "";
      if (slash.name === "new") { resetToNew(); renderLog(); }
      else if (slash.name === "resume") resumePrevious();
      else addLocalNote("`/" + escapeHtml(slash.name) + "` is only available on the desktop. Here, use **New** and **History** above, or `/resume`.");
      return;
    }
    input.value = "";
    autosize(input);
    ask(text);
  }

  // The box grows UPWARD (the composer is pinned at its bottom edge) one line at
  // a time, to at most COMPOSER_MAX_LINES; past that it scrolls inside, and the
  // user drags the text to see what they typed at the beginning.
  //
  // The composer is the LAST thing in the scroller, so a taller box pushes the
  // end of the log up behind it while scrollTop stays put — the newest answer
  // slid out of view with every line typed. A reader who was at the bottom is
  // kept there; one who had scrolled up to read is left where they were.
  var COMPOSER_MAX_LINES = 3;
  var AT_BOTTOM_SLACK_PX = 24;
  function atBottom() {
    var b = S.body;
    return !b || b.scrollHeight - b.scrollTop - b.clientHeight <= AT_BOTTOM_SLACK_PX;
  }
  function autosize(el) {
    var follow = atBottom();
    var cs = getComputedStyle(el);
    var line = parseFloat(cs.lineHeight) || 21;
    var pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    var border = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
    var max = Math.round(line * COMPOSER_MAX_LINES + pad + border);
    el.style.height = "auto";
    var want = el.scrollHeight + border;
    el.style.height = Math.min(want, max) + "px";
    el.style.overflowY = want > max ? "auto" : "hidden";
    if (follow) scrollToEnd();
  }

  // ─── On-screen keyboard fit (canon-mobile.md, the auth.js pattern) ─────
  // iOS keeps the layout viewport full height when the keyboard opens, so the
  // log's scroller ran on BEHIND the keyboard: with the composer grown to
  // three lines, what was left above it was a sliver that could not be
  // scrolled to show the latest answers. While the keyboard is up on this tab
  // .app is pinned to the visible rect (.chat-kb-open in mobile.css) — the log
  // then scrolls in exactly the space above the composer. Same threshold, rAF
  // coalescing and self-unmount check as auth.js; its own class, because
  // auth.js strips .kb-open whenever no login form is on screen.
  var KEYBOARD_MIN_PX = 120;   // below this it's browser chrome, not a keyboard
  var kb = { installed: false, pending: 0, open: false };

  function applyKeyboardFit() {
    kb.pending = 0;
    var app = document.getElementById("app");
    var vv = window.visualViewport;
    if (!app || !vv) return;
    // The tab is swapped out wholesale with no teardown hook, so every
    // measurement re-checks that the chat is still on screen.
    var layoutH = Math.max(window.innerHeight, document.documentElement.clientHeight || 0);
    var open = !!onThisTab() && layoutH - vv.height > KEYBOARD_MIN_PX;
    if (!open) { resetKeyboardFit(); return; }
    var follow = atBottom();
    app.style.setProperty("--chat-vv-height", vv.height + "px");
    app.style.setProperty("--chat-vv-offset-top", vv.offsetTop + "px");
    app.classList.add("chat-kb-open");
    // Only on the edge (keyboard just opened), and only for a reader already
    // at the newest answer — re-running on every viewport event would fight
    // the user's own scrolling.
    if (!kb.open && follow) scrollToEnd();
    kb.open = true;
  }

  function resetKeyboardFit() {
    var app = document.getElementById("app");
    if (app) {
      app.classList.remove("chat-kb-open");
      app.style.removeProperty("--chat-vv-height");
      app.style.removeProperty("--chat-vv-offset-top");
    }
    kb.open = false;
  }

  function scheduleKeyboardFit() {
    if (!kb.pending) kb.pending = window.requestAnimationFrame(applyKeyboardFit);
  }

  // Idempotent — every render of the tab calls it; the listeners live for the
  // page's lifetime and are a no-op once the chat is gone.
  function installKeyboardFit() {
    if (kb.installed || !window.visualViewport) return;
    kb.installed = true;
    window.visualViewport.addEventListener("resize", scheduleKeyboardFit);
    window.visualViewport.addEventListener("scroll", scheduleKeyboardFit);
    window.addEventListener("orientationchange", scheduleKeyboardFit);
    document.addEventListener("focusin", scheduleKeyboardFit);
    document.addEventListener("focusout", scheduleKeyboardFit);
  }

  // ─── Downloads ─────────────────────────────────────────────────────────
  function fileStem(title) {
    var d = new Date();
    var stamp = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    return (String(title || "polaris-report").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "polaris-report") + "-" + stamp;
  }
  function save(text, filename, type) {
    var url = URL.createObjectURL(new Blob([text], { type: type }));
    var a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  function download(r, kind) {
    if (kind === "md" && A()._reportToMarkdown) { save(A()._reportToMarkdown(r), fileStem(r.title) + ".md", "text/markdown;charset=utf-8"); return; }
    var cols = r.columns || [];
    var safe = A()._csvSafe || function (v) { return v == null ? "" : String(v); };
    var cell = function (v) { var s = safe(v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    var lines = [cols.map(function (c) { return cell(c.label); }).join(",")]
      .concat((r.rows || []).map(function (row) { return cols.map(function (c) { return cell(row[c.key]); }).join(","); }));
    save("﻿" + lines.join("\r\n"), fileStem(r.title) + ".csv", "text/csv;charset=utf-8");
  }

  // ─── History sheet (canon: mobile bottom sheet, openSiteSheet shape) ──
  function closeHistory() {
    var s = document.getElementById("chat-history-sheet"); if (s) s.remove();
    var sc = document.getElementById("chat-history-sheet-scrim"); if (sc) sc.remove();
  }
  function openHistory() {
    closeHistory();
    var scrim = document.createElement("div");
    scrim.className = "scrim"; scrim.id = "chat-history-sheet-scrim";
    var sheet = document.createElement("div");
    sheet.className = "sheet"; sheet.id = "chat-history-sheet";
    sheet.innerHTML = ''
      + '<div class="sheet-handle"></div>'
      + '<div style="display:flex;align-items:center;justify-content:space-between;padding:0 16px 8px;">'
      + '  <div class="sheet-title">Conversations</div>'
      + '  <button class="icon-btn" id="chat-history-sheet-close" aria-label="Close"><svg viewBox="0 0 24 24"><use href="#i-close"/></svg></button>'
      + '</div>'
      + '<div id="chat-history-list"><div class="loading-screen" style="padding:32px 0;"><div class="spinner"></div></div></div>';
    document.body.appendChild(scrim);
    document.body.appendChild(sheet);
    scrim.addEventListener("click", closeHistory);
    document.getElementById("chat-history-sheet-close").addEventListener("click", closeHistory);
    if (window.PolarisTabs && PolarisTabs.attachSwipeToDismiss) PolarisTabs.attachSwipeToDismiss(sheet, closeHistory);
    api.assistant.listConversations().then(function (r) {
      var list = document.getElementById("chat-history-list");
      if (!list) return;
      var convs = r.conversations || [];
      if (!convs.length) { list.innerHTML = '<div class="empty-state" style="padding:24px 0;"><div class="desc">No saved conversations yet.</div></div>'; return; }
      list.innerHTML = convs.map(function (c, i) {
        return '<button class="list-item two-line" data-open="' + escapeHtml(c.id) + '">'
          + '<span class="leading"><svg viewBox="0 0 24 24"><use href="#i-chat"/></svg></span>'
          + '<div class="content"><div class="headline">' + escapeHtml(c.title || "New conversation") + '</div>'
          + '<div class="supporting">' + escapeHtml(timeAgo(c.updatedAt)) + ' · ' + (c.messageCount | 0) + ' message' + (c.messageCount === 1 ? '' : 's') + '</div></div>'
          + '</button>' + (i < convs.length - 1 ? '<div class="list-divider"></div>' : '');
      }).join("");
      list.querySelectorAll("[data-open]").forEach(function (row) {
        row.addEventListener("click", function () {
          if (S.busy) { snack("Wait for the current answer, or press Stop"); return; }
          closeHistory();
          loadConversation(row.getAttribute("data-open")).then(function () { if (S.convId) markActive(); });
        });
      });
    }).catch(function (err) {
      var list = document.getElementById("chat-history-list");
      if (list) list.innerHTML = '<div class="empty-state" style="padding:24px 0;"><div class="desc">' + escapeHtml((err && err.message) || "Couldn’t load") + '</div></div>';
    });
  }

  // ─── Tab spec ──────────────────────────────────────────────────────────
  function unavailableHTML(why) {
    return ''
      + '<div class="empty-state" style="padding-top:48px;">'
      + '  <div class="icon"><svg viewBox="0 0 24 24"><use href="#i-chat"/></svg></div>'
      + '  <div class="ttl">The assistant isn’t available</div>'
      + '  <div class="desc">' + escapeHtml(why) + '</div>'
      + '</div>';
  }

  function wire(body) {
    var form = document.getElementById("chat-form");
    var input = document.getElementById("chat-input");
    form.addEventListener("submit", function (e) { e.preventDefault(); if (S.busy) stop(); else submit(); });
    input.addEventListener("input", function () { autosize(input); });
    installKeyboardFit();
    scheduleKeyboardFit();
    input.addEventListener("keydown", function (e) {
      // A hardware keyboard: Enter sends, Shift+Enter is a new line. The
      // on-screen keyboard's return key keeps inserting a new line.
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229 && matchMedia("(hover: hover)").matches) {
        e.preventDefault(); submit();
      }
    });
    body.querySelector("#chat-log").addEventListener("click", function (e) {
      // An asset-details link in an answer (the desktop's slide-over deep
      // link, /assets.html#view=asset:<id>) opens the phone's own asset
      // screen instead of loading the desktop page.
      var a = e.target.closest && e.target.closest('a[href^="/assets.html#view=asset:"]');
      if (a) {
        e.preventDefault();
        var m = /#view=asset:([^&]+)/.exec(a.getAttribute("href") || "");
        if (m && window.PolarisRouter) PolarisRouter.go("asset/" + decodeURIComponent(m[1]));
        return;
      }
      var d = e.target.closest("[data-dl]");
      if (!d) return;
      var msg = S.messages[+d.getAttribute("data-m")];
      var rep = msg && msg.reports ? msg.reports[+d.getAttribute("data-i")] : null;
      if (rep) download(rep, d.getAttribute("data-dl"));
    });
    var hist = document.getElementById("chat-history-btn");
    if (hist) hist.addEventListener("click", openHistory);
    var ralph = document.getElementById("chat-ralph-btn");
    if (ralph) ralph.addEventListener("click", toggleRalph);
    var fresh = document.getElementById("chat-new-btn");
    if (fresh) fresh.addEventListener("click", function () {
      if (S.busy) { snack("Wait for the current answer, or press Stop"); return; }
      resetToNew(); renderLog(); input.focus();
    });
  }

  var Chat = {
    title: "Chat",
    icon: "#i-chat",
    renderTopbar: function () {
      return ''
        + '<div class="m3-topbar">'
        + '  <div class="leading"></div>'
        + '  <div class="title" id="chat-title">' + escapeHtml(headerName()) + '</div>'
        + '  <div class="trailing">'
        + '    <button class="chat-ralph" id="chat-ralph-btn" aria-pressed="false" title="Real-time Assesser of Labor and Productivity Habits">R.A.L.P.H.</button>'
        + '    <button class="icon-btn" id="chat-history-btn" aria-label="Conversations"><svg viewBox="0 0 24 24"><use href="#i-history"/></svg></button>'
        + '    <button class="icon-btn" id="chat-new-btn" aria-label="New conversation"><svg viewBox="0 0 24 24"><use href="#i-add"/></svg></button>'
        + '  </div>'
        + '</div>';
    },
    render: function (body) {
      S.body = body;
      closeHistory();
      body.innerHTML = '<div class="loading-screen" style="padding:48px 0;"><div class="spinner"></div></div>';
      var statusP = S.status ? Promise.resolve(S.status) : api.assistant.status().then(function (s) { S.status = s; return s; });
      return statusP.then(function (s) {
        if (S.body !== body) return;
        if (!s || !s.enabled) { body.innerHTML = unavailableHTML("No AI Assistant integration is enabled on this Polaris."); return; }
        body.innerHTML = ''
          + '<div class="chat">'
          + '  <div class="chat-log" id="chat-log"></div>'
          + '  <form class="chat-composer" id="chat-form">'
          + '    <textarea id="chat-input" rows="1" placeholder="Ask about devices, alerts, networks…" autocomplete="off" enterkeyhint="send"></textarea>'
          + '    <button class="chat-send" id="chat-send" type="submit" aria-label="Send"><svg viewBox="0 0 24 24"><use href="#i-send"/></svg></button>'
          + '  </form>'
          + '</div>';
        wire(body);
        showRalph(!!s.efficiencyAdvisor);
        // Already holding a conversation in this page (back from another tab): keep it.
        if (S.busy || (S.convId && S.messages.length)) { renderLog(); return; }
        return latestActiveConversation().then(function (latest) {
          if (S.body !== body) return;
          // Activity on ANY device counts: the conversation this person used
          // within the idle window — on the desktop, say — is the one to open,
          // not whatever this phone last had. The server's updatedAt is the
          // only clock both devices share.
          if (latest) {
            S.convId = latest.id;
            lsSet(LS.conv, latest.id);
            markActive();
            return loadConversation(latest.id);
          }
          S.convId = lsGet(LS.conv) || null;
          if (S.convId && !idleResetIfDue()) return loadConversation(S.convId);
          renderLog();
        });
      }).catch(function (err) {
        if (S.body !== body) return;
        // A role without `assistant` gets 403 here.
        body.innerHTML = unavailableHTML(err && err.status === 403
          ? "Your role does not include the AI Assistant."
          : ((err && err.message) || "Could not reach the assistant."));
      });
    },
  };

  window.PolarisChatTab = { spec: Chat };
})();
