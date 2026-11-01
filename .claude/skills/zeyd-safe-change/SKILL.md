---
name: zeyd-safe-change
description: Safe change workflow for the ZEYD BARBER project. Use before any change to the site, the admin dashboard, tests, docs or Supabase files (bug fix, feature, refactor), so every change is scoped, planned, tested, reversible and reported.
---

# ZEYD BARBER — safe change workflow

Follow every step in order. Do not skip one because the change looks small.
If a step cannot be done (missing access, failing command), say so plainly and stop; never claim it was done.

## 1. Check the starting point

Run and report:

```bash
git status --short
git branch --show-current
git log --oneline -1
```

- The working tree must be clean. If it is not, stop and ask the owner what to do with the existing changes. Never discard, reset or stash them on your own (the stash is shared between worktrees).
- Write down the current commit SHA: it is the rollback point for this task (step 8).

## 2. Read only what the task touches

- Read the code related to the problem, then search where it is used (`Grep` for the function, id, CSS class, i18n key, table or RPC name) to know the impact of changing it.
- For database behaviour, read the migration that defines it and the matching test in `tests/`.
- Do not refactor or "clean up" unrelated code.

## 3. Plan before editing

Before the first edit, write a short plan with:

- the files that will change, and why each one;
- the tests that will prove the change (existing ones to run, new ones to add);
- the risks or side effects you can foresee.

Wait for the owner's go-ahead when the plan touches anything in step 4 or step 5.

## 4. Stay inside the scope

- Change only the files listed in the plan.
- If another file turns out to be necessary, explain why and ask for approval before touching it.

## 5. Changes that always need explicit approval

Never do any of these without a clear "yes" from the owner in the chat, for that specific action:

- changing the database: SQL, data (INSERT / UPDATE / DELETE), applying or re-running migrations, editing an already applied migration (new behaviour goes in a new migration file);
- changing Supabase settings (Auth, redirect URLs, storage, Edge Functions, secrets) or Stripe settings;
- changing accounts or roles (passwords, emails, `profiles.role`);
- merging into `main`, pushing, deploying or publishing the site;
- creating hooks, permissions or other persistent Claude Code configuration.

Never print or commit passwords, secret keys, tokens or `.env` content. Only the publishable key belongs in `Zeyd/config.js`.

## 6. Verify after every edit

```bash
npm run fix
npm run check
npm test
git diff --stat
git diff
```

- Biome: never use `--unsafe`. Biome does not check HTML or the strings inside `innerHTML`: review those by hand.
- Read the whole diff and remove anything not intended (unrelated formatting, debug code, stray files).
- For a visible change, check it in the browser preview (FR and AR, 375px and desktop width) and the console.
- `npm test` runs on PGlite, not on the real Supabase project: say so in the report.

## 7. Stop on failure

If a test fails, a check reports an error, or a side effect appears, stop. Find the cause before going further, and do not start the next task until it is fixed or the owner decides otherwise.

## 8. Keep a way back

- Commit before and after each set of changes (`CLAUDE.md`), with a clear message, so each change can be reverted with `git revert <sha>`.
- The rollback point of the task is the SHA from step 1.
- Work on the current branch only. Do not merge into `main`, do not deploy.

## 9. Security and side-effect review

Before calling the task done, check:

- permissions are still enforced by the database (RLS, `is_staff()` / `is_admin()`), not only by hiding UI elements;
- no secret, token or personal data is exposed in the code, the console or the URL;
- bilingual text (`i18n.js`, `admin-i18n.js`) exists in both languages and RTL/LTR still works;
- nothing else that uses the changed code is broken (usages from step 2).

## 10. Report

End with a report that lists:

- each file changed and why;
- the commits made (SHA and message) and the rollback point;
- the commands and tests run with their exact results (passed / failed / skipped);
- what was not tested and why (for example: real sign-in, real Supabase, real phone);
- anything that still needs the owner's decision.
