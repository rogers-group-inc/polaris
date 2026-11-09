/**
 * tests/unit/refuseRiskyHeredocHook.test.ts — pins the PreToolUse Bash hook
 * (.claude/skills/polaris-worktree-workflow/scripts/refuse-risky-heredoc.mjs)
 * that refuses the heredoc shapes the error log kept recording: a heredoc that
 * is a python/node program, a file-writing heredoc carrying backslashes or
 * non-ASCII, and a heredoc appended to a repo file. Plain commit messages,
 * data fed to a named script and one-liners must keep passing.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const HOOK = resolve(__dirname, "../../.claude/skills/polaris-worktree-workflow/scripts/refuse-risky-heredoc.mjs");

function run(command: string): { status: number; stderr: string } {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
    encoding: "utf8",
  });
  return { status: r.status ?? -1, stderr: r.stderr };
}

const BS = "\\";

describe("refuse-risky-heredoc hook — refuses what the error log recorded", () => {
  it.each([
    ["python - <<'EOF'", `python - <<'EOF'\nprint(1)\nEOF`],
    ["python3 - <<'PY' with a file argument", `cd x && python3 - tests/unit/a.test.ts <<'PY'\ns = open('a').read()\nPY`],
    ["node <<EOF", `node <<EOF\nconsole.log(1)\nEOF`],
    ["npx tsx <<EOF", `npx tsx <<'EOF'\nconsole.log(1)\nEOF`],
    ["a heredoc piped into python", `cat <<'EOF' | python -\nprint(1)\nEOF`],
    ["node.exe with only flags", `node.exe --input-type=module <<'EOF'\nimport x from "y";\nEOF`],
  ])("a heredoc used as a program: %s", (_label, cmd) => {
    const r = run(cmd);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/used as a .* program/);
    expect(r.stderr).toMatch(/Write tool/);
  });

  it("a file-writing heredoc whose body holds a backslash", () => {
    const r = run(`cat > /c/repo/scripts/x.mjs <<'EOF'\nconst s = a.join("${BS}n");\nEOF`);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/backslash or a non-ASCII/);
  });

  it("a file-writing heredoc whose body holds non-ASCII (the em dash that arrived as U+FFFD)", () => {
    expect(run(`cat > notes.md <<'EOF'\nA — B\nEOF`).status).toBe(2);
    expect(run(`tee out.txt <<'EOF'\ncafé\nEOF`).status).toBe(2);
  });

  it("a heredoc appended to a repo file (LF into a CRLF working copy)", () => {
    const r = run(`cat >> tests/unit/resolveMonitorSettings.test.ts <<'EOF'\nit("x", () => {});\nEOF`);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/appended to tests\/unit\/resolveMonitorSettings\.test\.ts/);
  });
});

describe("refuse-risky-heredoc hook — lets the ordinary shapes through", () => {
  it.each([
    ["a plain-ASCII commit message to the scratchpad", `cat > "$TEMP/msg.txt" <<'EOF'\nFix the thing\n\nCo-Authored-By: X <x@y>\nEOF\ngit commit -F "$TEMP/msg.txt"`],
    ["git commit -F - <<EOF", `git commit -F - <<'EOF'\nsubject\nEOF`],
    ["data fed to a named script", `node scripts/x.mjs <<'EOF'\n{"a":1}\nEOF`],
    ["an append into the temp folder", `cat >> "$TEMP/log.txt" <<'EOF'\nline\nEOF`],
    ["an append to the error log outside the repo", `cat >> ~/.claude/projects/p/error-log/2026-11-09-x.md <<'EOF'\nmore\nEOF`],
    ["an append into the scratchpad",`cat >> /c/Users/u/AppData/Local/Temp/claude/x/scratchpad/a.txt <<'EOF'\nline\nEOF`],
    ["a node -e one-liner with escapes", `node -e 'console.log("a${BS}nb")'`],
    ["no heredoc at all", `git status --short`],
    ["a here-string", `grep x <<< "a${BS}b"`],
    ["a plain-ASCII file write", `cat > "$TEMP/burn.js" <<'EOF'\nconst end = Date.now() + 9000; while (Date.now() < end) {}\nEOF`],
  ])("%s", (_label, cmd) => {
    expect(run(cmd).status).toBe(0);
  });

  it("does not read a heredoc's BODY as more commands", () => {
    // The body mentions `python - <<` as text; only the outer heredoc counts.
    expect(run(`cat > "$TEMP/doc.txt" <<'EOF'\nnever run python - <<EOF from a shell\nEOF`).status).toBe(0);
  });

  it("fails open on unreadable input", () => {
    const r = spawnSync(process.execPath, [HOOK], { input: "not json", encoding: "utf8" });
    expect(r.status).toBe(0);
  });
});
