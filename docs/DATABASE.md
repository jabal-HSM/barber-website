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
