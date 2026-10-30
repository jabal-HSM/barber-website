-- ZEYD BARBER — Phase 5: loyalty card (10 visits = 1 free cut) with QR code
-- How it works:
--   * every customer has one card with a random QR token (no personal data in the QR);
--   * after the cut, the customer shows the QR; Zeyd scans it in the dashboard and presses
--     "Confirmer la visite": only staff can add a stamp, at most one visit per customer per day;
--   * every 10th stamp creates one reward (unique per cycle, so it can never be granted twice);
--   * Zeyd redeems a reward once; the free cut is logged as a visit but earns no stamp.
-- Customers can only read their own card, visits and rewards: they have no write access at all.

begin;

create table if not exists public.loyalty_cards (
    customer_id uuid primary key references public.profiles (id) on delete cascade,
    token uuid not null unique default gen_random_uuid(),
    short_code text not null unique default upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)),
    stamps_total integer not null default 0 check (stamps_total >= 0),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists public.loyalty_visits (
    id uuid primary key default gen_random_uuid(),
    customer_id uuid not null references public.profiles (id) on delete cascade,
    visit_date date not null, -- salon (Paris) date
    kind text not null check (kind in ('stamp', 'reward')),
    booking_id uuid unique references public.bookings (id) on delete set null,
    confirmed_by uuid references auth.users (id) on delete set null,
    created_at timestamptz not null default now(),
    unique (customer_id, visit_date) -- a visit can never be counted twice the same day
);

create table if not exists public.loyalty_rewards (
    id uuid primary key default gen_random_uuid(),
    customer_id uuid not null references public.profiles (id) on delete cascade,
    cycle integer not null check (cycle >= 1), -- 1 = stamps 1–10, 2 = stamps 11–20, …
    earned_at timestamptz not null default now(),
    redeemed_at timestamptz,
    redeemed_by uuid references auth.users (id) on delete set null,
    redeemed_visit_id uuid references public.loyalty_visits (id) on delete set null,
    unique (customer_id, cycle)
);

drop trigger if exists loyalty_cards_set_updated_at on public.loyalty_cards;
create trigger loyalty_cards_set_updated_at
    before update on public.loyalty_cards
    for each row execute function public.set_updated_at();

-- A card for every customer, now and at sign-up
insert into public.loyalty_cards (customer_id)
select p.id from public.profiles p
on conflict (customer_id) do nothing;

create or replace function public.create_loyalty_card()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    insert into public.loyalty_cards (customer_id) values (new.id) on conflict (customer_id) do nothing;
    return new;
end;
$$;

revoke all on function public.create_loyalty_card() from public, anon, authenticated;

drop trigger if exists profiles_create_loyalty_card on public.profiles;
create trigger profiles_create_loyalty_card
    after insert on public.profiles
    for each row execute function public.create_loyalty_card();

-- ---------------------------------------------------------------------------
-- Read access: own rows, or staff. No write access through the API.
-- ---------------------------------------------------------------------------
alter table public.loyalty_cards enable row level security;
alter table public.loyalty_visits enable row level security;
alter table public.loyalty_rewards enable row level security;
select public.reset_policies('public.loyalty_cards');
select public.reset_policies('public.loyalty_visits');
select public.reset_policies('public.loyalty_rewards');

create policy "loyalty_cards: read own or staff" on public.loyalty_cards
    for select to authenticated
    using (customer_id = (select auth.uid()) or (select public.is_staff()));
create policy "loyalty_visits: read own or staff" on public.loyalty_visits
    for select to authenticated
    using (customer_id = (select auth.uid()) or (select public.is_staff()));
create policy "loyalty_rewards: read own or staff" on public.loyalty_rewards
    for select to authenticated
    using (customer_id = (select auth.uid()) or (select public.is_staff()));

revoke all on public.loyalty_cards, public.loyalty_visits, public.loyalty_rewards from anon, authenticated;
grant select on public.loyalty_cards, public.loyalty_visits, public.loyalty_rewards to authenticated;

-- ---------------------------------------------------------------------------
-- Customer: own card summary
-- ---------------------------------------------------------------------------
create or replace function public.my_loyalty()
returns table (
    full_name text,
    stamps_total integer,
    available_rewards integer,
    redeemed_rewards integer,
    token uuid,
    short_code text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
    uid uuid := auth.uid();
begin
    if uid is null then
        raise exception 'auth_required';
    end if;
    insert into public.loyalty_cards (customer_id)
    select uid where exists (select 1 from public.profiles where id = uid)
    on conflict (customer_id) do nothing;

    return query
        select p.full_name, c.stamps_total,
               (select count(*)::integer from public.loyalty_rewards r where r.customer_id = uid and r.redeemed_at is null),
               (select count(*)::integer from public.loyalty_rewards r where r.customer_id = uid and r.redeemed_at is not null),
               c.token, c.short_code
        from public.loyalty_cards c
        join public.profiles p on p.id = c.customer_id
        where c.customer_id = uid;
end;
$$;

revoke all on function public.my_loyalty() from public, anon;
grant execute on function public.my_loyalty() to authenticated;

-- ---------------------------------------------------------------------------
-- Staff: look up a QR / short code, confirm a visit, redeem a reward
-- Codes accepted: 'ZEYD-LOYALTY:<token>' (QR), '<token>', or the 8-character short code.
-- Errors: forbidden, invalid_code, already_counted, no_reward, invalid_booking
-- ---------------------------------------------------------------------------
create or replace function public.loyalty_resolve_code(p_code text)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    code text := upper(trim(regexp_replace(coalesce(p_code, ''), '^ZEYD-LOYALTY:', '', 'i')));
    found_id uuid;
begin
    if code ~ '^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$' then
        select c.customer_id into found_id from public.loyalty_cards c where c.token = code::uuid;
    elsif code ~ '^[0-9A-F]{8}$' then
        select c.customer_id into found_id from public.loyalty_cards c where c.short_code = code;
    end if;
    if found_id is null then
        raise exception 'invalid_code';
    end if;
    return found_id;
end;
$$;

revoke all on function public.loyalty_resolve_code(text) from public, anon, authenticated;

create or replace function public.loyalty_lookup(p_code text)
returns table (
    customer_id uuid,
    full_name text,
    email text,
    stamps_total integer,
    available_rewards integer,
    visits_count integer,
    last_visit date,
    visited_today boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    cid uuid;
    today date;
begin
    if not public.is_staff() then
        raise exception 'forbidden';
    end if;
    cid := public.loyalty_resolve_code(p_code);
    select (now() at time zone bs.timezone)::date into today from public.booking_settings bs where bs.id;
    return query
        select c.customer_id, p.full_name, p.email, c.stamps_total,
               (select count(*)::integer from public.loyalty_rewards r where r.customer_id = cid and r.redeemed_at is null),
               (select count(*)::integer from public.loyalty_visits v where v.customer_id = cid),
               (select max(v.visit_date) from public.loyalty_visits v where v.customer_id = cid),
               exists (select 1 from public.loyalty_visits v where v.customer_id = cid and v.visit_date = today)
        from public.loyalty_cards c
        join public.profiles p on p.id = c.customer_id
        where c.customer_id = cid;
end;
$$;

create or replace function public.loyalty_confirm_visit(p_code text, p_booking_id uuid default null)
returns table (stamps_total integer, reward_earned boolean, available_rewards integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
    cid uuid;
    today date;
    new_total integer;
    earned boolean := false;
begin
    if not public.is_staff() then
        raise exception 'forbidden';
    end if;
    cid := public.loyalty_resolve_code(p_code);
    select (now() at time zone bs.timezone)::date into today from public.booking_settings bs where bs.id;

    -- Lock the card: two scans at the same moment are handled one after the other
    perform 1 from public.loyalty_cards c where c.customer_id = cid for update;

    if p_booking_id is not null and not exists (
        select 1 from public.bookings b where b.id = p_booking_id and b.customer_id = cid
    ) then
        raise exception 'invalid_booking';
    end if;

    begin
        insert into public.loyalty_visits (customer_id, visit_date, kind, booking_id, confirmed_by)
        values (cid, today, 'stamp', p_booking_id, auth.uid());
    exception
        when unique_violation then
            raise exception 'already_counted';
    end;

    update public.loyalty_cards c
    set stamps_total = c.stamps_total + 1
    where c.customer_id = cid
    returning c.stamps_total into new_total;

    if new_total % 10 = 0 then
        insert into public.loyalty_rewards (customer_id, cycle) values (cid, new_total / 10)
        on conflict (customer_id, cycle) do nothing;
        earned := found;
    end if;

    if p_booking_id is not null then
        update public.bookings b set status = 'completed'
        where b.id = p_booking_id and b.status = 'confirmed' and b.starts_at <= now();
    end if;

    return query
        select new_total, earned,
               (select count(*)::integer from public.loyalty_rewards r where r.customer_id = cid and r.redeemed_at is null);
end;
$$;

create or replace function public.loyalty_redeem_reward(p_code text)
returns table (available_rewards integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
    cid uuid;
    today date;
    reward_id uuid;
    visit_id uuid;
begin
    if not public.is_staff() then
        raise exception 'forbidden';
    end if;
    cid := public.loyalty_resolve_code(p_code);
    select (now() at time zone bs.timezone)::date into today from public.booking_settings bs where bs.id;

    select r.id into reward_id
    from public.loyalty_rewards r
    where r.customer_id = cid and r.redeemed_at is null
    order by r.cycle
    limit 1
    for update;
    if reward_id is null then
        raise exception 'no_reward';
    end if;

    begin
        insert into public.loyalty_visits (customer_id, visit_date, kind, confirmed_by)
        values (cid, today, 'reward', auth.uid())
        returning id into visit_id;
    exception
        when unique_violation then
            raise exception 'already_counted';
    end;

    update public.loyalty_rewards
    set redeemed_at = now(), redeemed_by = auth.uid(), redeemed_visit_id = visit_id
    where id = reward_id;

    return query
        select count(*)::integer from public.loyalty_rewards r where r.customer_id = cid and r.redeemed_at is null;
end;
$$;

revoke all on function public.loyalty_lookup(text) from public, anon;
revoke all on function public.loyalty_confirm_visit(text, uuid) from public, anon;
revoke all on function public.loyalty_redeem_reward(text) from public, anon;
grant execute on function public.loyalty_lookup(text) to authenticated;
grant execute on function public.loyalty_confirm_visit(text, uuid) to authenticated;
grant execute on function public.loyalty_redeem_reward(text) to authenticated;

commit;
