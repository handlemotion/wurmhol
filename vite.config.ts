import { defineConfig } from "vite-plus";

// Workspace-wide toolchain: `vp fmt` (Oxfmt), `vp lint` (Oxlint with the vendored anti-slop rules)
// and `vp staged` for the pre-commit hook. Package builds and test suites keep their own configs.

const generated = [
  "**/node_modules/**",
  "**/dist/**",
  "**/.wrangler/**",
  "**/.astro/**",
  "**/migrations/**",
  "pnpm-lock.yaml",
  "**/worker-configuration.d.ts",
];

// Agent worktrees, skills and the vendored plugin are not application source. The repo's own skills
// are still formatted; the vendored gh-stack references and plugin keep their upstream formatting.
const agentTooling = [".agents/**", ".claude/**", "tools/oxlint/anti-slop/**"];

export default defineConfig({
  fmt: {
    printWidth: 100,
    ignorePatterns: [
      ...generated,
      ".claude/worktrees/**",
      ".claude/skills/gh-stack/references/**",
      "tools/oxlint/anti-slop/**",
      "docs/spec/**",
    ],
  },
  lint: {
    plugins: ["eslint", "typescript", "unicorn", "oxc", "import", "promise", "vitest"],
    jsPlugins: [
      { name: "vite-plus", specifier: "vite-plus/oxlint-plugin" },
      { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
    ],
    categories: {
      correctness: "error",
      suspicious: "warn",
    },
    env: { builtin: true },
    ignorePatterns: [...generated, ...agentTooling],
    rules: {
      "vitest/no-focused-tests": "error",
      "vitest/no-disabled-tests": "error",
      "typescript/no-explicit-any": "error",
      "typescript/no-non-null-assertion": "warn",
      "no-console": ["warn", { allow: ["warn", "error"] }],
      "vite-plus/prefer-vite-plus-imports": "error",

      // Cyclomatic complexity, ESLint's default ceiling of 20.
      complexity: "error",

      "oxc/no-accumulating-spread": "error",
      "anti-slop/no-array-filter-map": "error",
      "anti-slop/no-reduce-accumulator-copy": "error",
      "anti-slop/no-chained-type-assertions": "error",
      "anti-slop/no-conditional-empty-object-spread": "error",
      "anti-slop/no-known-value-widening": "error",
      "anti-slop/no-module-mocking": "error",
      "anti-slop/no-object-parameters": "error",
      "anti-slop/no-reflect-apply": "error",
      "anti-slop/no-reflect-get": "error",
      // Type guards are where an unparsed value is checked; protocol has no schema library.
      "anti-slop/no-runtime-typeof": ["error", { allowInTypeGuards: true }],
      "anti-slop/no-shape-in-symbol-names": "error",
      "anti-slop/no-unknown-parameters": "error",
      "anti-slop/no-unknown-returns": "error",
      "anti-slop/no-unknown-type-aliases": "error",
      "anti-slop/no-unsafe-dictionary-type": "error",
      "anti-slop/no-widen-then-assert": "error",
      "anti-slop/require-readable-spacing": "error",
      "anti-slop/require-safety-comment-for-type-assertion": "error",
    },
    overrides: [
      {
        files: ["scripts/**", "packages/cli/src/**"],
        rules: { "no-console": "off" },
      },
    ],
  },
  staged: {
    "*.{js,jsx,ts,tsx,mjs,cjs,json,jsonc,css,md,yml,yaml}":
      "vp fmt --no-error-on-unmatched-pattern",
    "*.{js,jsx,ts,tsx,mjs,cjs}": "vp lint --fix",
    "**/*.test.{ts,tsx,mts}": () => "node scripts/check-tests.mjs",
  },
});
