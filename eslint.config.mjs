// Pragmatic starter ESLint flat config for the TypeScript backend (src/).
//
// Deliberately conservative: a SMALL set of high-value correctness/hygiene
// rules that pass clean on the current tree, not the full recommended set
// (which would flood a large, organically-grown codebase with noise). Type-
// checked rules are intentionally OFF — they're slow and require the TS program;
// `npm run typecheck` already covers type correctness. Tighten over time.
//
// Frontend (public/) is plain browser globals with no module system and is not
// linted here. Generated Prisma client + vendored libs are ignored.

import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "src/generated/**",
      "public/js/vendor/**",
      "dist/**",
      "node_modules/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended.map((c) => ({
    ...c,
    files: ["src/**/*.ts"],
  })),
  {
    files: ["src/**/*.ts"],
    rules: {
      // High-value correctness rules kept as errors:
      "no-var": "error",
      "prefer-const": "error",
      eqeqeq: ["error", "smart"],

      // Pragmatic relaxations for this codebase (revisit incrementally):
      // - `any` is used widely at the Prisma/raw-SQL boundary on purpose.
      "@typescript-eslint/no-explicit-any": "off",
      // - many intentional empty catches (best-effort fire-and-forget paths).
      "no-empty": ["error", { allowEmptyCatch: true }],
      // - unused vars: warn, and allow the _-prefix + rest-sibling conventions.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
      // base rule must be off so the TS-aware one governs.
      "no-unused-vars": "off",
      // - this codebase legitimately matches control characters in regexes
      //   (stripping trailing NUL from SNMP OCTET STRINGs, SOH composite-key
      //   delimiters in LLDP) — the rule is a false positive here.
      "no-control-regex": "off",
      // - several hand-tuned regexes carry an explicit `\-` inside a character
      //   class for readability; rewriting working MAC/CIDR regexes to satisfy
      //   a cosmetic rule isn't worth the risk.
      "no-useless-escape": "off",
      // - new to @eslint/js 10's recommended set (2026-09), and it lands on 31
      //   pre-existing sites across ~20 files, nearly all of them the
      //   declare-then-assign-in-a-branch shape. It is a hygiene rule rather
      //   than a correctness one, and the premise of this config (see the
      //   header) is rules that pass clean on the current tree. Clearing those
      //   31 sites is a change of its own, not a rider on a security fix.
      "no-useless-assignment": "off",
    },
  },
);
