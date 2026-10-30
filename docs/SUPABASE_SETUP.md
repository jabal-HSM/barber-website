# Supabase setup and local development

## 1. Run the site locally
- VS Code Live Server on `Zeyd/index.html` (port 5501), or
  `python -m http.server 5501 --directory Zeyd --bind 127.0.0.1` then open http://127.0.0.1:5501
- With `BACKEND = null` in `Zeyd/config.js` the site works fully offline from `Zeyd/data.js`.

## 2. Tests and lint (no internet, no Docker needed)
```
npm install
npm test          # database migrations + permissions on PGlite, and api.js
npm run fix
npm run check
```

## 3. Create the dev project (once, free tier)
1. https://supabase.com/dashboard → **New project** → name `zeyd-dev`, region close to France (e.g. Paris / Frankfurt).
   Keep the database password in your password manager; it is not needed by the site.
2. **SQL Editor** → paste the whole content of `supabase/migrations/20261030120000_phase2_core.sql` → **Run**.
3. **Authentication → Sign In / Providers → Email**: keep "Confirm email" on.
   **Authentication → URL Configuration**: Site URL `http://127.0.0.1:5501` (dev only).
4. **Project Settings → API Keys**: copy the project URL and the **publishable** key (`sb_publishable_…`).
   Never copy the secret / service_role key into the project.
5. Put them in `Zeyd/config.js`:
   ```js
   export const BACKEND = { url: 'https://<ref>.supabase.co', publishableKey: 'sb_publishable_…' };
   ```

## 4. Check the dev project by hand
- The services section now comes from the database: change a price in **Table Editor → services** and reload.
- Make yourself admin after signing up: `update public.profiles set role = 'admin' where email = '<your email>';`
- Anonymous visitors must not see profiles: open
  `https://<ref>.supabase.co/rest/v1/profiles?select=id&apikey=<publishable key>` → must return `[]` or an error.

The account screens (sign-up, sign-in, likes buttons) are part of Phase 5; `Zeyd/api.js` already contains the functions.

## 5. Production project (later, with approval)
1. Back up first: **Database → Backups** (or `pg_dump`).
2. Check the sign-up trigger name (see `docs/DATABASE.md`).
3. Run the same migration in the production SQL editor, then point `config.js` to production.
