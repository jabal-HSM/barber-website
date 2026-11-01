# ZEYD BARBER — Database design

Backend: **Supabase** (PostgreSQL + Auth + Row Level Security + Storage). No custom server.
The site calls Supabase's REST API directly with the *publishable* key; every permission is enforced
inside the database by RLS policies and column grants. Secret / service_role keys are never used by the site.

Migrations live in `supabase/migrations/` and are tested offline by `npm test` (PGlite).

## Roles

| Role | Who | How it is assigned |
|---|---|---|
| `anon` | Visitor, not signed in | Supabase built-in |
| `customer` | Any signed-up account | Automatically at sign-up (trigger `handle_new_user`) — a role sent by the client is ignored |
| `barber` | Zeyd / staff | By an admin, in the SQL editor only |
| `admin` | Site owner | In the SQL editor only |

`public.is_staff()` = barber or admin, `public.is_admin()` = admin. Phase 4 adds a protected function to change roles from the admin panel.

## Tables in Phase 2

### `profiles` — one row per auth user
`id` (= auth.users.id) · `full_name` · `email` · `role` · `avatar_url` · `preferred_lang` (`fr`/`ar`) · `created_at` · `updated_at`

### `services`
`id` · `slug` (unique, = `id` in `Zeyd/data.js`) · `name_fr` · `name_ar` · `description_fr` · `description_ar` · `price` (€, ≥ 0) · `duration_minutes` (null = to be confirmed) · `is_active` · `sort_order` · timestamps

### `haircuts` — gallery photos (real work of the salon only)
`id` · `title_fr` · `title_ar` · `desc_fr` · `desc_ar` · `image_url` · `category` · `is_published` (default false) · `sort_order` · timestamps
(Old prototype columns `price` and `likes_count` are left untouched if present, and unused.)

### `haircut_likes`
`id` · `haircut_id` · `user_id` (defaults to the signed-in user) · `created_at` — unique (`haircut_id`, `user_id`).

### Function `gallery_with_likes()`
Published photos with `like_count` and `liked_by_me`, without revealing who liked what.

## Permission matrix

| | anon | customer | barber / admin |
|---|---|---|---|
| profiles | — | read/edit **own** row; only `full_name`, `avatar_url`, `preferred_lang` | read all |
| services | read active | read active | read all, create, edit, delete |
| haircuts | read published | read published | read all, create, edit, delete |
| haircut_likes | — | read/add/remove **own**; only on published photos; one per photo | own likes |
| gallery_with_likes() | yes | yes | yes |

Not allowed for anyone through the API: changing a role or an email, liking on behalf of someone else.

## Booking (Phase 3) — `20261030140000_phase3_booking.sql`

| Table / function | Content |
|---|---|
| `booking_settings` (single row) | `timezone` Europe/Paris · `slot_step_minutes` 15 · `min_notice_minutes` 60 · `max_days_ahead` 30 · `cancel_notice_minutes` 120 · `max_active_bookings` 2 |
| `business_hours` | Monday, Friday, Saturday: 09:00–12:00 and 14:00–19:00 (break = gap) |
| `closures` | Holidays / days off (`starts_on`, `ends_on` inclusive) |
| `bookings` | `customer_id`, `service_id`, `starts_at`, `ends_at`, `status` (`confirmed`, `requested`, `cancelled`, `completed`, `no_show`), `is_custom_request`, `customer_note` (≤ 300), `cancelled_at`, `cancelled_by` |
| `bookable_days()`, `available_slots(service, day)` | Public: times only, never who booked |
| `book_appointment(service, starts_at, note)` | Signed-in customers. Accepted only if the start is one of `available_slots` → confirmed at once |
| `request_custom_time(service, starts_at, note)` | Signed-in customers. Status `requested`, blocks nothing until confirmed |
| `cancel_booking(id)` | Own booking, ≥ 2 h before; staff anytime |
| `set_booking_status(id, status, ends_at)` | Staff only (admin panel in Phase 4) |

**Double booking:** exclusion constraint `bookings_no_overlap` on `tstzrange(starts_at, ends_at)` for confirmed bookings — the database refuses the second booking even if two customers click at the same moment.
Customers have no INSERT/UPDATE rights on `bookings`: only the functions above can change it.
Services without a known duration (`duration_minutes` null) cannot be booked online.

## Phase 3 (part 2) — `20261031090000_phase3_custom_time_gap.sql`
- Custom times (`request_custom_time`) follow the slot rules except the 15-minute grid: refused when
  `outside_hours` (closed day, break, after closing) or `too_close` (less than one cut — the service
  duration, 35 min — from another booking). Example: 16:00 booked → 16:15 refused, 16:35 accepted.
- A valid custom time is confirmed at once; with an unknown duration it stays `requested` but holds the
  chair for `min_gap_minutes` (35). The exclusion constraint now covers `requested` too.
- `booking_settings.booking_enabled` (holidays switch), `min_gap_minutes`.
- `staff_cancel_booking(id, reason)`: staff only; returns the customer's email, name and language so the
  dashboard can open a pre-written apology email.

## Phase 4 — `20261031100000_phase4_admin.sql`
- `set_user_role(user, role)`: admins only, never their own role.
- `booking_settings` and `payment_settings`: admin-only updates.
- Storage bucket `gallery` (public read, 5 MB, JPEG/PNG/WebP), staff-only upload/update/delete.

## Phase 5 — loyalty — `20261031110000_phase5_loyalty.sql`

| Table / function | Content |
|---|---|
| `loyalty_cards` | One per customer (created at sign-up): random `token` (QR), 8-char `short_code`, `stamps_total` |
| `loyalty_visits` | Visit log: date (Paris), `stamp` or `reward`, optional booking, `confirmed_by`. Unique per customer per day, unique per booking |
| `loyalty_rewards` | One per 10 stamps (`cycle` unique per customer), `redeemed_at` set once |
| `my_loyalty()` | The customer's own card |
| `loyalty_lookup(code)`, `loyalty_confirm_visit(code, booking)`, `loyalty_redeem_reward(code)` | Staff only |

The QR contains `ZEYD-LOYALTY:<random token>`: no personal data, and showing or scanning it changes
nothing. Customers have no write access to any loyalty table.

## Payments — `20261031120000_payments.sql` (off by default)

| Table / function | Content |
|---|---|
| `payment_settings` | `online_payments_enabled` (false), `hashem_share_cents` (500) |
| `payments` | One row per Checkout attempt: amount from the service price, `status` (`pending`, `paid`, `failed`, `expired`, `mismatch`, `duplicate`), Stripe ids, `livemode`, Telegram fields. One `paid` per booking |
| `stripe_events` | Every processed Stripe event id (replays ignored) |
| `staff_notifications` | "Paiement reçu : 10 €" for the dashboard, one per payment |
| `payment_create_pending`, `payment_attach_session`, `payment_mark_paid`, `payment_mark_failed`, `claim_telegram_notification`, `record_telegram_error` | **service_role only** (Edge Functions) |
| `barber_earnings()` | Staff: indicative barber share of paid payments |

Customers read their own payment status only (not the split nor the Telegram fields).

## Planned tables (not created yet)

| Phase | Table | Purpose |
|---|---|---|
| 5 | `loyalty_cards`, `visits`, `rewards` (prototype `loyalty_cards` exists) | Stamps credited only by staff when a visit is completed, never by the customer |
| 6 | `products`, `waitlist`, `reminders` | — |

## Existing production project (prototype) — notes

- `profiles` is currently readable by anonymous visitors (emails exposed). Fix: `supabase/fixes/2026-10-30_profiles_rls.sql`, also included in the Phase 2 migration.
- `bookings` and `loyalty_cards` exist from the prototype; they are not touched before Phases 3 and 5.
- Before applying the migration to production, check the sign-up trigger name:
  `select tgname from pg_trigger where tgrelid = 'auth.users'::regclass and not tgisinternal;`
  The migration replaces a trigger named `on_auth_user_created`. If the existing one has another name,
  drop it first, or two triggers will insert the profile.
