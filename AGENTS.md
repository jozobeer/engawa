# Engawa

Arc-style side-panel extension for Chrome (Manifest V3, zero dependencies, vanilla JS).

The canonical project guide is `CLAUDE.md` (Japanese) — read it first. Design decisions live in `.claude/rules/`; the feature spec is `README.md` (English).

Key context for agents working here:

- Node.js is managed by mise: `mise exec node@lts -- node ...` (`node` may not be on PATH otherwise)
- Verification contract is in `CLAUDE.md`: `node --check`, `scripts/check-i18n.mjs` (0 errors required), the `test-*.mjs` scripts, and per-suite headless-Chrome E2E (`scripts/e2e/`) run sequentially — UI changes must pass the matching suites before commit
- Classic scripts: every file's top-level functions are global; never reference another file's top-level `let` outside init-time function calls
- Commit messages: Japanese bullet style — what changed and why (see `CLAUDE.md` § コミット)
- Do not push to `origin` unless the user explicitly asks
