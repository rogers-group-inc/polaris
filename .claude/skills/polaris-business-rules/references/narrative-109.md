# Business rule 109 — full narrative

> Written 2026-10-12 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 109](#rule-109) — A value is encoded for the context it lands in, not for the one it came from

<a id="rule-109"></a>

## Rule 109 — A value is encoded for the context it lands in, not for the one it came from

### Where it came from

The third phase of the follow-up to the 2026-10-11 whole-repository security scan: nine findings, all of one shape. A value that came from somewhere an attacker could influence — an operator-typed name, a certificate filename, an ADOM, a device-reported serial or hostname — was escaped for ONE context and then placed in ANOTHER.

### Inline handlers (F167, F176, F177, F197, F235, F238)

The Integrations page, the API Tokens tab, the Certificates list and the asset HA panel built buttons by string concatenation: `onclick="deleteCA('` + `escapeHtml(cert.name)` + `')"`. `escapeHtml` is correct for text between tags and for an attribute value. It is wrong for a value inside a JavaScript string literal inside an attribute, because the HTML parser decodes the attribute's entities BEFORE the browser compiles it as script: `&#39;` becomes `'` again. A certificate uploaded with the filename `x');alert(1);('` therefore ran script in the browser of whoever next clicked Remove, and the same held for an integration name, a token name, an ADOM or VDOM, and an HA peer serial a managed device reports. The Content-Security-Policy did not stand in the way, because `scriptSrcAttr` allows inline handlers: the policy blocks injected `<script>` tags but this app still has 109 inline handlers.

**The decision** was to fix the encoding at every site rather than rewrite the handlers. `jsArg` encodes the value as a complete JSON string literal and then escapes that for HTML, so the attribute survives the parser and the literal survives the compiler. It supplies its own quotes. It is applied to EVERY data-bearing handler argument in `public/js` — 66 of them, including ids and enumerations that the server generates and cannot be hostile today — so there is one rule with no judgement call about which values are safe, and a test that fails on the old shape. Moving all 109 handlers to `addEventListener` with `data-*` attributes and dropping `unsafe-inline` for handlers is the real long-term fix; it is a large rewrite of a UI with no browser test harness and was deliberately left as its own change.

### CSV formulas (F241, F258)

The shared `_csvRow` quoted commas but not cells beginning with `=`, `+`, `-` or `@`, and the exports carry device-reported text (DHCP client names, VM names, SNMP `sysName`) and, in the Events export, the username typed into a failed unauthenticated login. Opened in a spreadsheet, such a cell is a formula. The cell is prefixed with a single quote so it reads as text, except a plain number (`-12.5`), which cannot be a formula and which a numeric column should keep. The logged username is capped at 128 characters, which fits a local name and an LDAP UPN.

### Slack and Teams (F248)

Alert text includes hostnames and event messages. Slack's rules say to escape `&`, `<` and `>` in text you did not write; without it `<!channel>` is a mass mention and `<https://evil|label>` a link with a label of the attacker's choosing. Teams `MessageCard` renders markdown in `text` and `title`, so those get the characters that introduce links, images, emphasis and headings backslash-escaped. The `View` link is built by the server after escaping and stays live, and the generic webhook is JSON that a receiving system renders, so it carries the raw values.

### The input layer behind it

An API token name, an integration name and an uploaded certificate's filename may not contain control characters, and a device-reported HA peer serial is stored only if it is 6 to 32 letters and digits. These are deliberately permissive — quotes and Unicode remain legal in a name — because the encoding above is what makes a name safe; the checks only keep a line break or separator out of the places that cannot cope.

### What it leaves open, on purpose

- **`scriptSrcAttr: 'unsafe-inline'` is unchanged**, so a handler written the old way by a future change would work and be exploitable; the static test is what stands in for the policy until the handlers are migrated.
- **Operators see a literal `<` in Slack** where a hostname contained one, and a leading apostrophe on an exported cell that began with `=`. Both are the point.
