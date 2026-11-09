#!/usr/bin/env node
// refuse-risky-heredoc.mjs — PreToolUse hook for Bash.
//
// The error log's largest live category after the 2026-11-04 review was a Bash heredoc
// mangling what it carried (~12 entries in four days, after the skill's "Shell notes" already
// said not to): `\n` and regex escapes inside python/node edit scripts arriving as literal
// newlines or eaten, an em dash arriving as U+FFFD, "unexpected EOF while looking for matching
// quote" on a script with mixed quotes, and `cat >> file <<EOF` appending LF lines into a CRLF
// working copy. A note did not stop it, so this refuses the three shapes outright:
//
//   1. a heredoc that IS a program — python / node / perl / ruby / bun / deno / tsx reading
//      its code from stdin (`python - <<EOF`, `node <<EOF`, `python3 - file <<'PY'`);
//   2. a heredoc that writes a file (`cat > f`, `tee f`) whose body holds a backslash or a
//      non-ASCII character;
//   3. a heredoc APPENDED (`>>`) to anything outside a temp / scratchpad folder (or the
//      ~/.claude/projects memory and error-log folders).
//
// Measured before registering (2026-11-09, replaying this project's session transcripts):
// 1318 Bash commands carried a heredoc; 735 were python/node programs, 638 of those with a
// backslash or non-ASCII in the body — so the risky content is the common case, not the edge,
// and narrowing rule 1 to "risky bodies only" would spare few. 110 were appends, mostly onto
// tests/unit/ and skill references. While writing this hook a quoted `<<'EOF'` node script
// lost a backslash (`[^/\\]` arrived as `[^/\]`): the mangling is the tool's, not bash's.
//
// Everything else passes: a plain-ASCII commit message (`cat > msg.txt <<'EOF'` then
// `git commit -F`), `git commit -F - <<EOF`, data fed to a named script (`node x.js <<EOF`),
// `node -e '…'` one-liners. The way past a refusal is always the same: Write the script (or
// the text) to the scratchpad with the Write tool and run / use the file; edit repo files
// with Edit.
//
// Register in the main checkout's .claude/settings.local.json (or ~/.claude/settings.json):
//   { "hooks": { "PreToolUse": [ { "matcher": "Bash",
//       "hooks": [ { "type": "command", "command": "f=\"$CLAUDE_PROJECT_DIR/.claude/skills/polaris-worktree-workflow/scripts/refuse-risky-heredoc.mjs\"; [ -f \"$f\" ] && exec node \"$f\"; exit 0" } ] } ] } }
//
// Blocks with exit code 2 (stderr is shown to Claude as the reason). Any unexpected error
// fails OPEN (exit 0) — a broken hook must not freeze every shell command.
import { readFileSync } from "node:fs";

const INTERPRETER = /(?:^|[\s;&|(/\\])(python3?|py|node|perl|ruby|bun|deno|tsx|ts-node)(?:\.exe)?(?=\s|$)(.*)$/;
// Append targets that are not a CRLF working copy: temp / scratchpad, and the per-project
// memory + error-log folders under ~/.claude/projects (LF files outside any repository).
const TEMP_PATH = /(\$\{?(TEMP|TMP|TMPDIR)\}?|\/tmp\/|[\\/]Temp[\\/]|scratchpad|[\\/]\.claude[\\/]projects[\\/])/i;

/** Every heredoc in a shell command: the text before `<<` on its line, and its body. */
export function findHeredocs(command) {
  const out = [];
  const lines = command.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const re = /(^|[^<])<<(-?)\s*(['"]?)([A-Za-z_][\w.-]*)\3/g;
    let m;
    while ((m = re.exec(lines[i])) !== null) {
      const dash = m[2] === "-";
      const delim = m[4];
      const head = lines[i].slice(0, m.index + m[1].length);
      const tail = lines[i].slice(m.index + m[0].length);
      const body = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const l = dash ? lines[j].replace(/^\t+/, "") : lines[j];
        if (l === delim) break;
        body.push(lines[j]);
      }
      out.push({ head, tail, body: body.join("\n") });
      i = Math.max(i, j); // the body is not scanned for more heredocs
      break;
    }
  }
  return out;
}

/** The current pipeline segment of `head` (after the last ; && || or |). */
function segment(head) {
  const parts = head.split(/;|&&|\|\||\|/);
  return parts[parts.length - 1];
}

/** Why this heredoc is refused, or null when it may run. */
export function refusal({ head, tail, body }) {
  const seg = segment(head) + " " + tail.split(/;|&&|\|\||\|/)[0];
  // The program reading the heredoc: the command it is attached to, or one it is
  // piped into (`cat <<EOF | python -`).
  const pipedInto = (tail.split(/;|&&|\|\|/)[0] ?? "").split("|").slice(1);
  for (const cmd of [segment(head), ...pipedInto]) {
    const im = INTERPRETER.exec(cmd);
    if (!im) continue;
    const args = im[2].trim().split(/\s+/).filter(Boolean);
    const readsCodeFromStdin = args.length === 0 || args.includes("-") || args.every((a) => a.startsWith("-"));
    if (readsCodeFromStdin) {
      return `a heredoc used as a ${im[1]} program — escapes (\\n, \\r\\n, regex backslashes), non-ASCII and mixed quotes are mangled on the way in`;
    }
  }
  const append = />>\s*["']?([^\s"';&|]+)/.exec(seg);
  if (append && !TEMP_PATH.test(append[1])) {
    return `a heredoc appended to ${append[1]} — it writes LF lines, and this repo's working copy is CRLF, so the file ends up with mixed endings`;
  }
  const writes = /(^|\s)(>|>>)\s*\S|(^|\s)tee(\s|$)/.test(seg);
  if (writes && /[\\]|[^\x00-\x7f]/.test(body)) {
    return "a heredoc writing a file whose body holds a backslash or a non-ASCII character — both are mangled through the shell";
  }
  return null;
}

function main() {
  let input = {};
  try { input = JSON.parse(readFileSync(0, "utf8") || "{}"); } catch { process.exit(0); }
  const command = input?.tool_input?.command;
  if (typeof command !== "string" || !command.includes("<<")) process.exit(0);
  for (const h of findHeredocs(command)) {
    const why = refusal(h);
    if (why) {
      process.stderr.write(
        `Refused (refuse-risky-heredoc): ${why}.\n` +
        "Write the script or text to your scratchpad with the Write tool, then run it " +
        "(`python <file>`, `node <file>`) or pass the file (`git commit -F <file>`); edit repo files with Edit. " +
        "See .claude/skills/polaris-worktree-workflow/SKILL.md → Shell notes.\n",
      );
      process.exit(2);
    }
  }
  process.exit(0);
}

try {
  if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) main();
} catch (err) {
  process.stderr.write(`refuse-risky-heredoc: hook error, allowing: ${err?.message ?? err}\n`);
  process.exit(0);
}
