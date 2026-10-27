---
name: design-sync
description: "Polaris's /design-sync: re-publish the two Polaris design systems — Polaris UI (desktop + the alert email) and Polaris Mobile (the phone) — to their claude.ai ARTIFACTS from design/ and the app's own stylesheets, by the procedure in .design-sync/NOTES.md. Replaces Claude Code's bundled design-sync for this repo: Polaris does not sync to a standalone claude.ai/design project (standalone Claude Design closes 2026-12-14), never uses the DesignSync tool, and never builds a React bundle. Run it when the user types /design-sync, says sync / re-sync / publish the design system, Polaris UI, Polaris Mobile or the design artifacts, or after a commit that changed public/css/styles.css, public/css/mobile.css, design/**, the alert email template or .design-sync/**."
disable-model-invocation: true
---

# Design sync — Polaris UI and Polaris Mobile

The two Polaris design systems are **claude.ai artifacts**, published read-only from this
repo. The repo is the standard; the artifacts are copies. This skill is the
`/design-sync` entry point; the procedure itself lives in **`.design-sync/NOTES.md`** —
read it first, every time, and follow its publish procedure step by step.

| System | Artifact | Source |
|---|---|---|
| Polaris UI | https://claude.ai/artifact/2Haqgf2NSW7KUuc9JuTKgz | `design/desktop/` + `public/css/styles.css` + the alert email template |
| Polaris Mobile | https://claude.ai/artifact/U1moTSRwvzveB4xQpmLLed | `design/mobile/` + `public/css/mobile.css` |

The urls also live in `.design-sync/config.json` (`systems.<id>.artifact`), which is what
`node .design-sync/build.mjs` reads.

## Rules the procedure assumes

- **The Artifact tool does all of it** — `read`, `publish` with `url` + `root` + `files`,
  `asset: true` for logos. Not the `DesignSync` tool, not claude.ai/design, not a React
  bundle, not `_ds_sync.json`. If the bundled design-sync instructions appear (first-sync
  questions, "create a new project", Storybook detection), they are for other repos — ignore
  them here.
- **Which system** comes from NOTES.md's "When to sync" table. Sync only the system(s)
  whose sources moved; say so when nothing did.
- **Publish committed code.** The index's `lastChange.via` is `Polaris repo @<short sha>`,
  so build from a checkout whose state that sha describes — normally `main` after a push
  (`/polaris-deploy` step 8 runs exactly this). When the user asks to preview an unmerged
  branch, build from its worktree and say so in `lastChange.note`
  (`"worktree-<slug>, uncommitted"`), and tell them the artifact now shows work that may
  never merge.
- **The build is the gate.** `node .design-sync/build.mjs` fails on a page that uses a class
  the app stylesheet no longer defines, or a token that no longer resolves. Fix the page in
  `design/<system>/components/`, never `ds-bundle/`. A change that alters what a page
  demonstrates (a class retired, a pattern's look or rule changed) also updates that page
  and its README in the same branch.
- **Read before you write.** Each system's live artifact is read first (NOTES.md step 2);
  a `lastChange` that is newer than the last sync and not from this repo stops the run —
  ask before overwriting.
- **The index goes last**, with every key kept and `"editing": "code"`.

Report per system: the artifact url, the files published and removed, and the
`lastChange` written — or "current, nothing to publish".

Related: `polaris-ui-canon` (design-first rule, the canon each page demonstrates),
`polaris-deploy` (pipeline step 8 runs this after a push).
