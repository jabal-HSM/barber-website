# Supabase, Stripe and Telegram setup

Projects: **zeyd-dev-1** (`eyqlptbocufkxcpblpxu`, development, linked in `Zeyd/config.js`) and the
production project (`ajvswfsslwwlpsbtoccz`, not linked yet — Phase 7).

## 1. Run the site locally
- Always through a local server, never by double-clicking `index.html` (`file://`): browsers block
  the JavaScript modules there and no button works (the page now shows a red notice in that case).
- Until the work branch is merged, the sign-in screen, booking, loyalty and dashboard exist only in the
  worktree `.claude/worktrees/zeyd-barber-phase-1-28351e/`. The folder `C:\Users\dev\Desktop\zeyd\Zeyd`
  (branch `main`) is still Phase 1 and has no sign-in at all.
- With Live Server started at the repository root (port 5501), open
  http://127.0.0.1:5501/.claude/worktrees/zeyd-barber-phase-1-28351e/Zeyd/index.html
  or, in a terminal at the worktree root: `python -m http.server 5501 --directory Zeyd --bind 127.0.0.1`
  (stop Live Server first) then open http://127.0.0.1:5501
- Dashboard: same folder, `admin.html` (staff accounts only).
- After pulling new code, reload with **Ctrl+F5**: browsers keep old JavaScript modules in cache.

### Auth → URL Configuration (zeyd-dev-1, one time)
Email confirmation is on (checked 2026-10-31: `mailer_autoconfirm=false`). The confirmation link goes back
to the page where the account was created, but only if that address is allowed:
1. Supabase → zeyd-dev-1 → Authentication → URL Configuration.
2. **Site URL**: `http://127.0.0.1:5501`
3. **Redirect URLs** → Add: `http://127.0.0.1:5501/**` and `http://localhost:5501/**` → Save.
Without it, the link opens the Site URL (the old Phase 1 page) and you must sign in again by hand.
The built-in email sender only sends a few emails per hour; if no email arrives, wait and retry.

Measured on 2026-10-31 (an invalid token sent to `/auth/v1/verify`; the `Location` of the answer shows where
Supabase sends people back):

| `redirect_to` | Supabase sends back to |
|---|---|
| `http://127.0.0.1:5501/.claude/worktrees/…/Zeyd/index.html` | that page ✅ |
| `http://localhost:5501/…` | `http://127.0.0.1:5501/` (not allowed yet) |
| `http://192.168.1.20:5501/…` (PC address on the Wi-Fi) | `http://127.0.0.1:5501/` (not allowed) |

`127.0.0.1` is "this device": opened on a phone, it points to the phone itself, so the page never loads.
Supabase confirms the address *before* this redirect, so the account is usually confirmed anyway: sign in.

### Testing from a phone (same Wi-Fi as the PC)
1. On the PC: `ipconfig` → "IPv4 Address" of the Wi-Fi adapter, e.g. `192.168.1.20`.
2. Live Server must accept other devices: VS Code settings → `liveServer.settings.host` = `0.0.0.0`
   (then restart Live Server). Allow Node/VS Code through the Windows firewall on *private* networks if asked.
3. Supabase → Redirect URLs → Add `http://192.168.1.20:5501/**` (your own address) → Save.
4. On the phone open `http://192.168.1.20:5501/.claude/worktrees/zeyd-barber-phase-1-28351e/Zeyd/index.html`,
   create the account there and open the email link **on the phone** (the link brings you back to the page
   where the account was created).
5. If a link fails or expired, the sign-in form says so and offers « Renvoyer l’e-mail de confirmation ».

## 2. Tests and lint (no internet, no Docker)
```
npm install
npm test          # migrations + permissions on PGlite, booking rules, loyalty, payments, Edge Function logic
npm run fix
npm run check
```

## 3. Database migrations (SQL Editor of the project, in name order, each once)

| File | zeyd-dev-1 | Production |
|---|---|---|
| `20261030120000_phase2_core.sql` | applied | not yet |
| `20261030130000_revoke_internal_functions.sql` | applied | not yet |
| `20261030140000_phase3_booking.sql` | applied (checked 2026-10-31) | not yet |
| `20261031090000_phase3_custom_time_gap.sql` | applied (checked 2026-10-31) | not yet |
| `20261031100000_phase4_admin.sql` | applied (checked 2026-10-31) | not yet |
| `20261031110000_phase5_loyalty.sql` | applied (checked 2026-10-31) | not yet |
| `20261031120000_payments.sql` | applied (checked 2026-10-31) | not yet |

Production only received `supabase/fixes/2026-10-30_profiles_rls.sql` (email leak fix, verified).

## 4. Give Zeyd (and you) access to the dashboard
Nobody becomes staff at sign-up. After the accounts exist (sign up on the site, confirm the email), run once in the SQL editor of **zeyd-dev-1**:
```sql
update public.profiles set role = 'admin' where email = '<Zeyd email>';
```
Afterwards an admin can change roles from the dashboard (tab « Clients »); nobody can change their own role.

## 5. Edge Functions (Stripe checkout + webhook) — one-time setup
Requires a Supabase access token (Dashboard → Account → Access Tokens). In a terminal at the project root:
```
npx supabase login
npx supabase link --project-ref eyqlptbocufkxcpblpxu
npx supabase functions deploy create-checkout
npx supabase functions deploy stripe-webhook --no-verify-jwt
```

### Secrets
1. Copy `supabase/functions/.env.example` to `supabase/functions/.env` (same folder; ignored by Git).
2. Fill in the values after each `=`.
3. Send them: `npx supabase secrets set --env-file supabase/functions/.env`

## 6. Telegram
1. In Telegram, talk to **@BotFather** → `/newbot` → copy the token it gives (looks like `123456789:AAH…`).
2. Open your new bot and press **Start** (a bot can only write to someone who started it).
3. In `supabase/functions/.env`: `TELEGRAM_BOT_TOKEN=` ← paste the token right after `=`. `TELEGRAM_CHAT_ID=8705155832` is already filled.
4. Run the `secrets set` command of §5 again.
The message is sent only for a **real** (live) confirmed payment, once per payment. To try it with a Stripe test payment, set `TELEGRAM_NOTIFY_TEST_PAYMENTS=true`, test, then put it back to `false`.

## 7. Stripe (mother's account)
Test mode first — no real money:
1. The mother creates the Stripe account **in her own name** (dashboard.stripe.com), with her email.
2. Developers → API keys (**Test mode**): copy the **Secret key** `sk_test_…` → `STRIPE_SECRET_KEY=` in `.env`.
3. Developers → Webhooks → Add endpoint:
   - URL: `https://eyqlptbocufkxcpblpxu.supabase.co/functions/v1/stripe-webhook`
   - Events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
     `checkout.session.async_payment_failed`, `checkout.session.expired`
   - Copy the **Signing secret** `whsec_…` → `STRIPE_WEBHOOK_SECRET=` in `.env`.
4. `npx supabase secrets set --env-file supabase/functions/.env`
5. Dashboard (admin) → Réglages → tick « Afficher le bouton Payer en ligne ».
6. Test with Stripe's test card `4242 4242 4242 4242` (any future date, any CVC) on a booking of a test account.

Going live (later, with the owner's approval): the mother completes Stripe's identity and business
verification and adds a **bank account (IBAN) in her name** for payouts — a Visa card alone is not
enough. Then replace the keys with the live ones (`sk_live_…`, live webhook secret) and set
`ALLOW_LIVE_PAYMENTS=true`. The server refuses live keys until then.

The whole amount goes to the Stripe account whose keys are configured (no split between accounts).
Stripe deducts its processing fee from each payment before the payout (check the current French
pricing on stripe.com/fr/pricing). The "Part de Zeyd" card in the dashboard is only an indicative
split (amount − `hashem_share_cents`, 5 € by default) and moves no money.

## 8. Production (Phase 7, with approval)
1. Back up first (Database → Backups).
2. Check the sign-up trigger name (see `docs/DATABASE.md`).
3. Apply the same migrations, deploy the functions to the production project, then point `config.js` to production.
4. Configure a real email sender (SMTP) in Supabase Auth: the built-in one sends only a few emails per hour.
