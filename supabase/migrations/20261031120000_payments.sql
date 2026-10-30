-- ZEYD BARBER — online payments (Stripe Checkout), prepared but OFF by default
-- Flow:
--   1. a signed-in customer presses "Payer en ligne" on a confirmed booking;
--   2. the Edge Function create-checkout (server side, secret key in Supabase secrets) calls
--      payment_create_pending(): the amount comes from the service price in the database, never
--      from the browser; it then opens a Stripe Checkout page;
--   3. Stripe calls the Edge Function stripe-webhook; only a verified "paid" event marks the payment
--      as paid (payment_mark_paid). Each Stripe event is processed once (stripe_events), a booking can
--      be paid only once, and the dashboard notification / Telegram message can only be sent once.
-- All money goes to the single Stripe account whose keys are configured (the mother's account).
-- The "barber share" is only an indicative split shown in Zeyd's dashboard (amount minus
-- hashem_share_cents); it moves no money.

begin;

create table if not exists public.payment_settings (
    id boolean primary key default true check (id),
    online_payments_enabled boolean not null default false,
    hashem_share_cents integer not null default 500 check (hashem_share_cents >= 0),
    currency text not null default 'eur' check (currency = 'eur'),
    updated_at timestamptz not null default now()
);

insert into public.payment_settings (id) values (true) on conflict (id) do nothing;

drop trigger if exists payment_settings_set_updated_at on public.payment_settings;
create trigger payment_settings_set_updated_at
    before update on public.payment_settings
    for each row execute function public.set_updated_at();

create table if not exists public.payments (
    id uuid primary key default gen_random_uuid(),
    booking_id uuid not null references public.bookings (id) on delete restrict,
    customer_id uuid not null references public.profiles (id) on delete restrict,
    amount_cents integer not null check (amount_cents > 0),
    currency text not null default 'eur',
    barber_share_cents integer not null check (barber_share_cents >= 0),
    status text not null default 'pending' check (status in ('pending', 'paid', 'failed', 'expired', 'mismatch', 'duplicate')),
    stripe_checkout_session_id text unique,
    stripe_payment_intent_id text,
    livemode boolean,
    paid_at timestamptz,
    telegram_notified_at timestamptz,
    telegram_error text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

-- A booking can be paid only once
create unique index if not exists payments_one_paid_per_booking on public.payments (booking_id) where status = 'paid';
create index if not exists payments_customer_idx on public.payments (customer_id, created_at desc);

drop trigger if exists payments_set_updated_at on public.payments;
create trigger payments_set_updated_at
    before update on public.payments
    for each row execute function public.set_updated_at();

-- Every Stripe event id seen: a retried or replayed event is ignored
create table if not exists public.stripe_events (
    id text primary key,
    type text not null,
    received_at timestamptz not null default now()
);

-- Private notifications for the barber's dashboard ("Paiement reçu : 10 €")
create table if not exists public.staff_notifications (
    id uuid primary key default gen_random_uuid(),
    kind text not null check (kind in ('payment')),
    payment_id uuid unique references public.payments (id) on delete cascade,
    amount_cents integer not null,
    livemode boolean not null default false,
    created_at timestamptz not null default now(),
    read_at timestamptz
);

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------
alter table public.payment_settings enable row level security;
alter table public.payments enable row level security;
alter table public.stripe_events enable row level security;
alter table public.staff_notifications enable row level security;
select public.reset_policies('public.payment_settings');
select public.reset_policies('public.payments');
select public.reset_policies('public.stripe_events');
select public.reset_policies('public.staff_notifications');

create policy "payment_settings: public read" on public.payment_settings
    for select to anon, authenticated using (true);
create policy "payment_settings: admin update" on public.payment_settings
    for update to authenticated
    using ((select public.is_admin()))
    with check ((select public.is_admin()));

create policy "payments: read own or staff" on public.payments
    for select to authenticated
    using (customer_id = (select auth.uid()) or (select public.is_staff()));

create policy "staff_notifications: staff read" on public.staff_notifications
    for select to authenticated using ((select public.is_staff()));
create policy "staff_notifications: staff mark read" on public.staff_notifications
    for update to authenticated
    using ((select public.is_staff()))
    with check ((select public.is_staff()));

revoke all on public.payment_settings, public.payments, public.stripe_events, public.staff_notifications
    from anon, authenticated;
grant select on public.payment_settings to anon, authenticated;
grant update (online_payments_enabled, hashem_share_cents) on public.payment_settings to authenticated;
-- Customers see their payment status, never the internal split or Telegram fields
grant select (id, booking_id, customer_id, amount_cents, currency, status, paid_at, created_at)
    on public.payments to authenticated;
grant select on public.staff_notifications to authenticated;
grant update (read_at) on public.staff_notifications to authenticated;
-- stripe_events: no access at all except the server (service_role)

-- ---------------------------------------------------------------------------
-- Server-only functions (called by the Edge Functions with the service_role key)
-- ---------------------------------------------------------------------------
create or replace function public.payment_create_pending(p_booking_id uuid, p_customer_id uuid)
returns table (payment_id uuid, amount_cents integer, currency text, service_name_fr text, starts_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
    settings public.payment_settings;
    b public.bookings;
    price_cents integer;
    new_id uuid;
begin
    select * into settings from public.payment_settings ps where ps.id;
    if not settings.online_payments_enabled then
        raise exception 'payments_disabled';
    end if;

    select * into b from public.bookings where bookings.id = p_booking_id for update;
    if not found or b.customer_id <> p_customer_id then
        raise exception 'not_found';
    end if;
    if b.status not in ('confirmed', 'completed') then
        raise exception 'invalid_status';
    end if;
    if exists (select 1 from public.payments p where p.booking_id = p_booking_id and p.status = 'paid') then
        raise exception 'already_paid';
    end if;

    select round(sv.price * 100)::integer into price_cents from public.services sv where sv.id = b.service_id;
    if price_cents is null or price_cents <= 0 then
        raise exception 'service_unavailable';
    end if;

    insert into public.payments (booking_id, customer_id, amount_cents, currency, barber_share_cents)
    values (b.id, b.customer_id, price_cents, settings.currency, greatest(price_cents - settings.hashem_share_cents, 0))
    returning payments.id into new_id;

    return query
        select new_id, price_cents, settings.currency, sv.name_fr, b.starts_at
        from public.services sv where sv.id = b.service_id;
end;
$$;

create or replace function public.payment_attach_session(p_payment_id uuid, p_session_id text)
returns void
language sql
security definer
set search_path = ''
as $$
    update public.payments set stripe_checkout_session_id = p_session_id
    where id = p_payment_id and stripe_checkout_session_id is null;
$$;

-- Called for checkout.session.completed (payment_status = paid) and async_payment_succeeded.
-- newly_paid is true exactly once per payment, whatever the number of events or retries.
create or replace function public.payment_mark_paid(
    p_event_id text,
    p_event_type text,
    p_session_id text,
    p_payment_intent_id text,
    p_amount_total integer,
    p_currency text,
    p_livemode boolean
)
returns table (payment_id uuid, newly_paid boolean, amount_cents integer, barber_share_cents integer, livemode boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
    p public.payments;
begin
    insert into public.stripe_events (id, type) values (p_event_id, p_event_type) on conflict (id) do nothing;
    if not found then
        return query select null::uuid, false, null::integer, null::integer, p_livemode; -- replayed event
        return;
    end if;

    select * into p from public.payments where stripe_checkout_session_id = p_session_id for update;
    if not found then
        raise exception 'unknown_session';
    end if;
    if p.status = 'paid' then
        return query select p.id, false, p.amount_cents, p.barber_share_cents, p.livemode;
        return;
    end if;
    -- Never trust a paid event whose amount or currency differs from what was asked
    if p_amount_total is distinct from p.amount_cents or lower(p_currency) is distinct from p.currency then
        update public.payments set status = 'mismatch', livemode = p_livemode where id = p.id;
        return query select p.id, false, p.amount_cents, p.barber_share_cents, p_livemode;
        return;
    end if;

    -- Paid twice for the same booking (two tabs): keep the first, flag this one for a refund
    if exists (select 1 from public.payments o where o.booking_id = p.booking_id and o.status = 'paid') then
        update public.payments
        set status = 'duplicate', stripe_payment_intent_id = p_payment_intent_id, livemode = p_livemode
        where id = p.id;
        return query select p.id, false, p.amount_cents, p.barber_share_cents, p_livemode;
        return;
    end if;

    update public.payments
    set status = 'paid', paid_at = now(), stripe_payment_intent_id = p_payment_intent_id, livemode = p_livemode
    where id = p.id;

    insert into public.staff_notifications (kind, payment_id, amount_cents, livemode)
    values ('payment', p.id, p.barber_share_cents, p_livemode)
    on conflict on constraint staff_notifications_payment_id_key do nothing;

    return query select p.id, true, p.amount_cents, p.barber_share_cents, p_livemode;
end;
$$;

-- checkout.session.expired / async_payment_failed: never overrides a paid payment
create or replace function public.payment_mark_failed(p_event_id text, p_event_type text, p_session_id text, p_status text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
    if p_status not in ('failed', 'expired') then
        raise exception 'invalid_status';
    end if;
    insert into public.stripe_events (id, type) values (p_event_id, p_event_type) on conflict (id) do nothing;
    if not found then
        return;
    end if;
    update public.payments set status = p_status
    where stripe_checkout_session_id = p_session_id and status = 'pending';
end;
$$;

-- Returns true only for the first caller: the Telegram message is sent at most once per payment.
create or replace function public.claim_telegram_notification(p_payment_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
    update public.payments set telegram_notified_at = now(), telegram_error = null
    where id = p_payment_id and status = 'paid' and telegram_notified_at is null;
    return found;
end;
$$;

-- If sending failed, keep the error for the dashboard (no automatic re-send, so never a duplicate).
create or replace function public.record_telegram_error(p_payment_id uuid, p_error text)
returns void
language sql
security definer
set search_path = ''
as $$
    update public.payments set telegram_error = left(p_error, 300) where id = p_payment_id;
$$;

revoke all on function public.payment_create_pending(uuid, uuid) from public, anon, authenticated;
revoke all on function public.payment_attach_session(uuid, text) from public, anon, authenticated;
revoke all on function public.payment_mark_paid(text, text, text, text, integer, text, boolean)
    from public, anon, authenticated;
revoke all on function public.payment_mark_failed(text, text, text, text) from public, anon, authenticated;
revoke all on function public.claim_telegram_notification(uuid) from public, anon, authenticated;
revoke all on function public.record_telegram_error(uuid, text) from public, anon, authenticated;
grant execute on function public.payment_create_pending(uuid, uuid) to service_role;
grant execute on function public.payment_attach_session(uuid, text) to service_role;
grant execute on function public.payment_mark_paid(text, text, text, text, integer, text, boolean) to service_role;
grant execute on function public.payment_mark_failed(text, text, text, text) to service_role;
grant execute on function public.claim_telegram_notification(uuid) to service_role;
grant execute on function public.record_telegram_error(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- Staff: indicative earnings card (sum of the barber share of confirmed payments)
-- ---------------------------------------------------------------------------
create or replace function public.barber_earnings()
returns table (livemode boolean, payments_count integer, barber_share_cents bigint, amount_cents bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
    if not public.is_staff() then
        raise exception 'forbidden';
    end if;
    return query
        select coalesce(p.livemode, false), count(*)::integer, sum(p.barber_share_cents), sum(p.amount_cents)
        from public.payments p
        where p.status = 'paid'
        group by coalesce(p.livemode, false);
end;
$$;

revoke all on function public.barber_earnings() from public, anon;
grant execute on function public.barber_earnings() to authenticated;

commit;
