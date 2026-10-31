# Deployment — preparation (nothing is deployed yet)

Status 2026-10-31: the site runs only locally (Live Server). There is **no public URL** yet. Production
Supabase (`ajvswfsslwwlpsbtoccz`) has received only the profiles security fix. Stripe is in test mode.

## 1. What is deployed where

| Part | Where | Notes |
|---|---|---|
| Website (`Zeyd/`: HTML, CSS, JS modules, images, sounds) | a static host | no build step |
| Database, sign-in, photos | Supabase project | dev = `zeyd-dev-1`, prod = separate project |
| Server code (`supabase/functions/`) | Supabase Edge Functions | secrets set per project |

## 2. Recommended host: Cloudflare Pages (or Netlify)

Both serve static files for free with HTTPS, a global CDN, a custom domain and the `Zeyd/_headers` file
(no-cache for pages and scripts, so a new version never mixes with an old cached one).
- **Cloudflare Pages**: Dashboard → Workers & Pages → Create → Pages → *Upload assets* → upload the `Zeyd`
  folder (or connect a Git repository, build command empty, output directory `Zeyd`).
- **Netlify**: drag and drop the `Zeyd` folder on app.netlify.com/drop, then claim the site.
GitHub Pages also works but needs a public repository (the project has no remote today).

## 3. Before the first production deployment (with the owner's approval)

1. **Backup** production: Supabase → Database → Backups (the free plan has no automatic backups: run
   `npx supabase db dump --linked -f backup-prod-YYYY-MM-DD.sql` from a linked CLI and keep the file
   outside Git).
2. **Migrations** on production, in this order, each once (SQL Editor or `npx supabase db push`):
   `20261030120000_phase2_core`, `20261030130000_revoke_internal_functions`, `20261030140000_phase3_booking`,
   `20261031090000_phase3_custom_time_gap`, `20261031100000_phase4_admin`, `20261031110000_phase5_loyalty`,
   `20261031120000_payments`, `20261101090000_phase6_cancellations`, `20261101100000_phase6_loyalty`,
   `20261101110000_phase6_schedule_customers`, `20261101120000_phase6_allocations`.
   They were written to work on the existing production tables (tested on a copy of the prototype schema),
   but apply them on **zeyd-dev-1 first** and test there.
3. **Auth → URL Configuration** (production project): Site URL = the public address
   (e.g. `https://zeydbarber.fr`); Redirect URLs = `https://zeydbarber.fr/**` (+ the `*.pages.dev` address
   while testing). Keep **email confirmation on**. Configure a real SMTP sender (Auth → SMTP): the built-in
   one sends only a few emails per hour.
4. **Edge Functions** on production: `npx supabase link --project-ref ajvswfsslwwlpsbtoccz`, then deploy
   `create-checkout`, `stripe-webhook --no-verify-jwt`, `notify-staff`, and set the secrets (§4).
5. **Point the site to production**: in `Zeyd/config.js` add a `PROD` object (production URL + *publishable*
   key only) and set `BACKEND = PROD` in the release commit. Never put a secret or service_role key there.
6. **Deploy** `Zeyd/` to the host, then test (§6).

## 4. Environment variables (Supabase secrets, per project — never in Git, never in the site)

| Name | Dev | Prod |
|---|---|---|
| `STRIPE_SECRET_KEY` | `sk_test_…` | `sk_test_…` until the owner approves live |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` of the test endpoint | `whsec_…` of the prod endpoint |
| `ALLOW_LIVE_PAYMENTS` | `false` | `false` until approval |
| `TELEGRAM_BOT_TOKEN` | bot token | bot token |
| `TELEGRAM_CHAT_ID` | `8705155832` | `8705155832` |
| `TELEGRAM_STAFF_CHAT_ID` | Zeyd's chat id | Zeyd's chat id |
| `TELEGRAM_STAFF_LANG` | `fr` | `fr` or `ar` |
| `TELEGRAM_NOTIFY_TEST_PAYMENTS` | `false` | `false` |
| `SITE_URL` | `http://127.0.0.1:5501` | `https://<domain>` |
| `ALLOWED_ORIGINS` | local addresses | `https://<domain>` |

Template: `supabase/functions/.env.example` → copy to `.env` (ignored by Git) →
`npx supabase secrets set --env-file supabase/functions/.env`.

## 5. Domain and DNS

1. Buy the domain (e.g. at OVH, Gandi, Cloudflare Registrar).
2. In the host: *Custom domains* → add `zeydbarber.fr` and `www.zeydbarber.fr`.
3. At the registrar: the DNS records the host shows (usually a `CNAME www → <project>.pages.dev` and, for the
   bare domain, the host's `A`/`ALIAS`/`CNAME flattening` record). HTTPS certificates are automatic.
4. Update Supabase Site URL / Redirect URLs, `SITE_URL`, `ALLOWED_ORIGINS` and the Stripe webhook URL.

## 6. Tests after deployment (on the public address, phone and computer)

Open the URL · sign up (email arrives, link returns signed in) · sign in/out · book a slot · try to book the
same slot from another account (refused) · cancel with a reason (shown in the dashboard, Telegram if
configured) · reschedule · dashboard access refused to a customer account · Zeyd's account sees the dashboard
· loyalty QR scanned with Zeyd's phone · sound settings persist · French/Arabic · Stripe **test** payment
`4242 4242 4242 4242` · webhook event received (Stripe Dashboard → Webhooks) · allocation shown in « Paiements ».
Give the public URL only after these pass.

## 7. Administrator access for Zeyd (no shared password)

1. Zeyd creates his own account on the public site with his own email and password, and confirms the email.
2. The project owner, signed in to the Supabase dashboard of the right project, runs in the SQL Editor:
   `update public.profiles set role = 'admin' where email = '<Zeyd email>';`
   (or `'barber'` for a staff account that cannot change roles or settings).
3. Zeyd opens `https://<domain>/admin.html`. Roles are checked by the database on every action; knowing the
   address is not enough. Nobody can change their own role.
4. Recommended: a strong unique password and, later, Supabase Auth MFA.

## 8. Remaining risks — to approve before going live

- [ ] Phase 6 migrations not yet applied anywhere; apply and test on dev first.
- [ ] Real sign-up / confirmation / sign-in not yet tested end to end on a phone.
- [ ] Telegram to Zeyd: needs his chat id and the `notify-staff` deployment.
- [ ] Stripe: test mode only; PayPal / Google Pay to enable in the Dashboard; fee bearer undecided;
      automatic split (Connect) not implemented — payouts are manual (see `docs/PAYMENTS.md`).
- [ ] Mother's notification: behaviour to decide (see `docs/PAYMENTS.md` §7).
- [ ] Built-in Supabase email sender limited; configure SMTP.
- [ ] Free Supabase plan: no automatic backups; plan regular dumps.
- [ ] Durations of « Coupe enfant » and « Coupe et barbe » still unknown (not bookable online).
- [ ] Legal pages (mentions légales, confidentialité / RGPD) not written yet.
