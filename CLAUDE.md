# ZEYD BARBER

Static website (HTML/CSS/JS ES modules) in `Zeyd/`. No build step; served with VS Code Live Server on port 5501. Project phases and current state: `PROJECT_STATUS.md`.

## Lint & format: Biome

Biome is installed as a dev dependency at the repo root (`package.json`, config in `biome.json`).

- After editing any `.js` or `.css` file in `Zeyd/`, run `npm run fix` (safe fixes + formatting), then `npm run check`, and resolve any remaining errors before finishing.
- Never run `biome check --write --unsafe`: its fixes (e.g. `noImportantStyles` deleting `!important`) change behaviour, not just style. The Phase 1 stylesheet has no `!important`; keep it that way.
- Style: 4-space indent, single quotes in JS, 120-column lines, CRLF line endings.
- Biome does not check HTML files or the JS template strings inside `innerHTML`. Review those by hand.

## Version control

Git repository on branch `main` (no remote). GitLens is installed in VS Code for the user; it is a UI extension with no CLI, so use the `git` CLI directly (log, blame, diff) for history questions.

- Commit before and after each set of changes to the site, so every change can be reverted.
- `.env`, `node_modules/` and `.backup-before-biome/` are ignored; never commit secrets.

Ruff (Python) is installed on the machine but is not used here: the project has no Python files.
