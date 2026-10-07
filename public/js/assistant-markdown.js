/**
 * public/js/assistant-markdown.js — the AI assistant's Markdown renderer.
 *
 * ESCAPE-FIRST. Model output is untrusted text (it can echo device names,
 * descriptions and alert messages that came from the network — business rule
 * 94's prompt-injection note), so every character is HTML-escaped before any
 * Markdown is recognized, and the only markup ever produced is the fixed set
 * below. No raw HTML passes through, ever; links are limited to http(s) and
 * same-origin paths and always open in a new tab with noopener.
 *
 * Covers what a chat answer needs: paragraphs, # / ## / ### headings, bullet
 * and numbered lists, > quotes, fenced code, pipe tables, **bold**, *italic*,
 * `code` and [links](url). Anything else renders as the literal text.
 *
 * Exposes window.PolarisMarkdown.render(text) → HTML string.
 */
(function (root) {
  "use strict";

  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // Applied to ALREADY-ESCAPED text. The URL inside a link was escaped with
  // the rest, so it is unescaped only to test its scheme, never to emit.
  function safeHref(escapedUrl) {
    var raw = escapedUrl.replace(/&amp;/g, "&").trim();
    if (/^https?:\/\//i.test(raw)) return escapedUrl.trim();
    if (/^\/(?!\/)/.test(raw)) return escapedUrl.trim();
    return null;
  }

  function inline(escaped) {
    // Code spans first, parked behind placeholders so nothing inside them is
    // treated as emphasis or a link.
    var codes = [];
    var out = escaped.replace(/`([^`]+)`/g, function (_m, c) {
      codes.push("<code>" + c + "</code>");
      return "\u0000" + (codes.length - 1) + "\u0000";
    });
    out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (m, text, url) {
      var href = safeHref(url);
      if (!href) return m;
      return '<a href="' + href + '" target="_blank" rel="noopener noreferrer">' + text + "</a>";
    });
    // Bare https URLs not already inside an anchor.
    out = out.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, function (_m, lead, url) {
      return lead + '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + "</a>";
    });
    out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\*)/g, "$1<em>$2</em>");
    out = out.replace(/(^|[^\w])_([^_\s][^_]*)_(?!\w)/g, "$1<em>$2</em>");
    out = out.replace(/\u0000(\d+)\u0000/g, function (_m, i) { return codes[+i]; });
    return out;
  }

  function splitRow(line) {
    var s = line.trim();
    if (s.charAt(0) === "|") s = s.slice(1);
    if (s.charAt(s.length - 1) === "|") s = s.slice(0, -1);
    return s.split("|").map(function (c) { return c.trim(); });
  }

  function isTableSep(line) {
    return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
  }

  function render(text) {
    var lines = String(text == null ? "" : text).replace(/\r\n/g, "\n").split("\n");
    var html = [];
    var i = 0;
    var para = [];

    function flushPara() {
      if (para.length) {
        html.push("<p>" + para.map(function (l) { return inline(esc(l)); }).join("<br>") + "</p>");
        para = [];
      }
    }

    while (i < lines.length) {
      var line = lines[i];

      // Fenced code — taken verbatim (escaped), never inline-formatted. An
      // unterminated fence (mid-stream) runs to the end of the text.
      var fence = /^\s*(```|~~~)(.*)$/.exec(line);
      if (fence) {
        flushPara();
        var body = [];
        i++;
        while (i < lines.length && !/^\s*(```|~~~)\s*$/.test(lines[i])) { body.push(lines[i]); i++; }
        i++;
        html.push('<pre class="asst-code"><code>' + esc(body.join("\n")) + "</code></pre>");
        continue;
      }

      if (!line.trim()) { flushPara(); i++; continue; }

      var h = /^(#{1,3})\s+(.*)$/.exec(line);
      if (h) {
        flushPara();
        var lvl = h[1].length + 3; // # → h4: chat headings stay small
        html.push("<h" + lvl + ">" + inline(esc(h[2])) + "</h" + lvl + ">");
        i++;
        continue;
      }

      if (line.indexOf("|") !== -1 && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        flushPara();
        var head = splitRow(line);
        i += 2;
        var rows = [];
        while (i < lines.length && lines[i].indexOf("|") !== -1 && lines[i].trim()) { rows.push(splitRow(lines[i])); i++; }
        html.push('<div class="asst-table-wrap"><table class="asst-table"><thead><tr>' +
          head.map(function (c) { return "<th>" + inline(esc(c)) + "</th>"; }).join("") +
          "</tr></thead><tbody>" +
          rows.map(function (r) {
            return "<tr>" + head.map(function (_c, k) { return "<td>" + inline(esc(r[k] == null ? "" : r[k])) + "</td>"; }).join("") + "</tr>";
          }).join("") +
          "</tbody></table></div>");
        continue;
      }

      var ul = /^\s*[-*+]\s+(.*)$/.exec(line);
      var ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      if (ul || ol) {
        flushPara();
        var tag = ul ? "ul" : "ol";
        var re = ul ? /^\s*[-*+]\s+(.*)$/ : /^\s*\d+[.)]\s+(.*)$/;
        var items = [];
        while (i < lines.length) {
          var m = re.exec(lines[i]);
          if (m) { items.push(m[1]); i++; continue; }
          // A wrapped continuation line belongs to the previous item.
          if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) { items[items.length - 1] += " " + lines[i].trim(); i++; continue; }
          break;
        }
        html.push("<" + tag + ">" + items.map(function (it) { return "<li>" + inline(esc(it)) + "</li>"; }).join("") + "</" + tag + ">");
        continue;
      }

      var q = /^\s*>\s?(.*)$/.exec(line);
      if (q) {
        flushPara();
        var quote = [];
        while (i < lines.length) {
          var qm = /^\s*>\s?(.*)$/.exec(lines[i]);
          if (!qm) break;
          quote.push(qm[1]);
          i++;
        }
        html.push("<blockquote>" + quote.map(function (l) { return inline(esc(l)); }).join("<br>") + "</blockquote>");
        continue;
      }

      para.push(line);
      i++;
    }
    flushPara();
    return html.join("");
  }

  root.PolarisMarkdown = { render: render, escape: esc };
})(typeof window !== "undefined" ? window : globalThis);
