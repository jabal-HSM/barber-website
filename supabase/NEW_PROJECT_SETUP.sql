-- ZEYD BARBER: full database setup for a NEW, EMPTY Supabase project.
-- Generated from supabase/migrations (14 files, in order). Paste all of it in SQL Editor and click Run once.
-- Do not run it on a project that already has these tables.

-- ===== 20261030120000_phase2_core.sql =====
-- ZEYD BARBER — Phase 2 core schema
-- Profiles & roles, services, haircut gallery & likes, all protected by Row Level Security.
--
-- Safe on a fresh Supabase project AND on the existing prototype tables (same names, columns added only).
-- It never drops a table, a column or a row. Re-running it is harmless.
-- Bookings, opening hours and loyalty are designed in docs/DATABASE.md and arrive in Phases 3 and 5:
-- this file does not touch public.bookings or public.loyalty_cards.
--
-- Roles: customer (default) < barber < admin. Promote someone only from the SQL editor:
--   update public.profiles set role = 'admin' where email = '<their email>';

begin;

-- ---------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    new.updated_at := now();
    return new;
end;
$$;

-- Drops every policy on a table so this migration always ends in a known state
-- (the prototype had permissive policies, e.g. profiles readable by anyone).
create or replace function public.reset_policies(target regclass)
returns void
language plpgsql
set search_path = ''
as $$
declare
    p record;
begin
    for p in
        select pol.polname
        from pg_catalog.pg_policy pol
        where pol.polrelid = target
    loop
        execute format('drop policy %I on %s', p.polname, target);
    end loop;
end;
$$;

revoke all on function public.reset_policies(regclass) from public;

-- ---------------------------------------------------------------------------
-- Profiles (one per auth user)
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
    id uuid primary key references auth.users (id) on delete cascade,
    full_name text,
    email text,
    role text not null default 'customer',
    avatar_url text,
    created_at timestamptz not null default now()
);

alter table public.profiles add column if not exists preferred_lang text not null default 'fr';
alter table public.profiles add column if not exists updated_at timestamptz not null default now();

do $$
begin
    if not exists (select 1 from pg_constraint where conname = 'profiles_role_check') then
        alter table public.profiles
            add constraint profiles_role_check check (role in ('customer', 'barber', 'admin'));
    end if;
    if not exists (select 1 from pg_constraint where conname = 'profiles_preferred_lang_check') then
        alter table public.profiles
            add constraint profiles_preferred_lang_check check (preferred_lang in ('fr', 'ar'));
    end if;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
    before update on public.profiles
    for each row execute function public.set_updated_at();

-- Role checks used by policies. SECURITY DEFINER so they can read profiles without recursing into RLS.
create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select exists (
        select 1 from public.profiles
        where id = (select auth.uid()) and role in ('barber', 'admin')
    );
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select exists (
        select 1 from public.profiles
        where id = (select auth.uid()) and role = 'admin'
    );
$$;

-- Create the profile automatically at sign-up. Role is always 'customer' here,
-- whatever the client puts in the sign-up metadata.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    insert into public.profiles (id, email, full_name, preferred_lang)
    values (
        new.id,
        new.email,
        nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
        case when new.raw_user_meta_data ->> 'preferred_lang' = 'ar' then 'ar' else 'fr' end
    )
    on conflict (id) do nothing;
    return new;
end;
$$;

revoke all on function public.handle_new_user() from public;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
    after insert on auth.users
    for each row execute function public.handle_new_user();

alter table public.profiles enable row level security;
select public.reset_policies('public.profiles');

create policy "profiles: read own row or staff" on public.profiles
    for select to authenticated
    using (id = (select auth.uid()) or (select public.is_staff()));

create policy "profiles: update own row" on public.profiles
    for update to authenticated
    using (id = (select auth.uid()))
    with check (id = (select auth.uid()));

-- Anonymous visitors: nothing. Signed-in users may only change harmless columns (never role or email).
revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
grant update (full_name, avatar_url, preferred_lang) on public.profiles to authenticated;

-- ---------------------------------------------------------------------------
-- Services (prices and durations, editable by staff in Phase 4)
-- ---------------------------------------------------------------------------
create table if not exists public.services (
    id uuid primary key default gen_random_uuid(),
    name_fr text not null,
    name_ar text not null,
    price numeric(6, 2) not null,
    duration_minutes integer,
    created_at timestamptz not null default now()
);

alter table public.services add column if not exists slug text;
alter table public.services add column if not exists description_fr text;
alter table public.services add column if not exists description_ar text;
alter table public.services add column if not exists is_active boolean not null default true;
alter table public.services add column if not exists sort_order integer not null default 0;
alter table public.services add column if not exists updated_at timestamptz not null default now();
-- null = duration not known yet (shown as "to be confirmed")
alter table public.services alter column duration_minutes drop not null;

create unique index if not exists services_slug_key on public.services (slug);

do $$
begin
    if not exists (select 1 from pg_constraint where conname = 'services_price_check') then
        alter table public.services add constraint services_price_check check (price >= 0);
    end if;
    if not exists (select 1 from pg_constraint where conname = 'services_duration_check') then
        alter table public.services
            add constraint services_duration_check check (duration_minutes is null or duration_minutes > 0);
    end if;
end;
$$;

drop trigger if exists services_set_updated_at on public.services;
create trigger services_set_updated_at
    before update on public.services
    for each row execute function public.set_updated_at();

-- Seed the 8 services from Zeyd/data.js.
-- Existing rows (matched by French name) only get slug, descriptions and order: their price and
-- duration are kept, because they belong to the salon. Missing services are inserted.
create temporary table service_seed (
    slug text,
    name_fr text,
    name_ar text,
    description_fr text,
    description_ar text,
    price numeric(6, 2),
    duration_minutes integer,
    sort_order integer
) on commit drop;

insert into service_seed values
    ('degrade-bas', 'Dégradé bas', 'تدرّج منخفض',
        'Dégradé court, près de la nuque et des tempes.', 'تدرّج قصير قرب الرقبة والصدغين.', 15, 35, 10),
    ('degrade-moyen', 'Dégradé moyen', 'تدرّج متوسط',
        'Dégradé qui remonte jusqu’à mi-hauteur des côtés.', 'تدرّج يرتفع حتى منتصف الجانبين.', 15, 35, 20),
    ('degrade-haut', 'Dégradé haut', 'تدرّج عالٍ',
        'Dégradé marqué, remonté haut sur les côtés.', 'تدرّج واضح يرتفع عالياً على الجانبين.', 15, 35, 30),
    ('degrade-progressif', 'Dégradé progressif', 'تدرّج تدريجي',
        'Transition douce et graduelle sur les côtés.', 'انتقال ناعم ومتدرّج على الجانبين.', 15, 35, 40),
    ('coupe-classique', 'Coupe classique', 'قصّة كلاسيكية',
        'Coupe traditionnelle, nette et facile à coiffer.', 'قصّة تقليدية مرتّبة وسهلة التصفيف.', 15, 35, 50),
    ('coupe-ciseaux', 'Coupe aux ciseaux', 'قصّة بالمقص',
        'Coupe réalisée entièrement aux ciseaux.', 'قصّة منفّذة بالكامل بالمقص.', 15, 35, 60),
    ('coupe-enfant', 'Coupe enfant', 'قصّة للأطفال',
        'Coupe de cheveux pour les enfants.', 'قصّة شعر مخصّصة للأطفال.', 10, null, 70),
    ('coupe-et-barbe', 'Coupe et barbe', 'قصّة ولحية',
        'Coupe de cheveux et taille de la barbe.', 'قصّة شعر مع تهذيب اللحية.', 15, null, 80);

update public.services s
set slug = seed.slug,
    description_fr = coalesce(s.description_fr, seed.description_fr),
    description_ar = coalesce(s.description_ar, seed.description_ar),
    sort_order = seed.sort_order
from service_seed seed
where s.slug is null
  and lower(s.name_fr) = lower(seed.name_fr)
  and not exists (select 1 from public.services other where other.slug = seed.slug);

insert into public.services
    (slug, name_fr, name_ar, description_fr, description_ar, price, duration_minutes, sort_order)
select seed.slug, seed.name_fr, seed.name_ar, seed.description_fr, seed.description_ar,
       seed.price, seed.duration_minutes, seed.sort_order
from service_seed seed
where not exists (select 1 from public.services s where s.slug = seed.slug);

alter table public.services enable row level security;
select public.reset_policies('public.services');

create policy "services: public read of active services" on public.services
    for select to anon, authenticated
    using (is_active or (select public.is_staff()));

create policy "services: staff insert" on public.services
    for insert to authenticated
    with check ((select public.is_staff()));

create policy "services: staff update" on public.services
    for update to authenticated
    using ((select public.is_staff()))
    with check ((select public.is_staff()));

create policy "services: staff delete" on public.services
    for delete to authenticated
    using ((select public.is_staff()));

revoke all on public.services from anon, authenticated;
grant select on public.services to anon, authenticated;
grant insert, update, delete on public.services to authenticated;

-- ---------------------------------------------------------------------------
-- Haircut gallery (real photos only; managed by staff in Phase 4)
-- ---------------------------------------------------------------------------
create table if not exists public.haircuts (
    id uuid primary key default gen_random_uuid(),
    title_fr text,
    title_ar text,
    desc_fr text,
    desc_ar text,
    image_url text not null,
    created_at timestamptz not null default now()
);

alter table public.haircuts add column if not exists category text;
alter table public.haircuts add column if not exists is_published boolean not null default false;
alter table public.haircuts add column if not exists sort_order integer not null default 0;
alter table public.haircuts add column if not exists updated_at timestamptz not null default now();

drop trigger if exists haircuts_set_updated_at on public.haircuts;
create trigger haircuts_set_updated_at
    before update on public.haircuts
    for each row execute function public.set_updated_at();

alter table public.haircuts enable row level security;
select public.reset_policies('public.haircuts');

create policy "haircuts: public read of published photos" on public.haircuts
    for select to anon, authenticated
    using (is_published or (select public.is_staff()));

create policy "haircuts: staff insert" on public.haircuts
    for insert to authenticated
    with check ((select public.is_staff()));

create policy "haircuts: staff update" on public.haircuts
    for update to authenticated
    using ((select public.is_staff()))
    with check ((select public.is_staff()));

create policy "haircuts: staff delete" on public.haircuts
    for delete to authenticated
    using ((select public.is_staff()));

revoke all on public.haircuts from anon, authenticated;
grant select on public.haircuts to anon, authenticated;
grant insert, update, delete on public.haircuts to authenticated;

-- ---------------------------------------------------------------------------
-- Likes: one per user and photo, only by signed-in users, only on published photos
-- ---------------------------------------------------------------------------
create table if not exists public.haircut_likes (
    id uuid primary key default gen_random_uuid(),
    haircut_id uuid not null references public.haircuts (id) on delete cascade,
    user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
    created_at timestamptz not null default now()
);

create unique index if not exists haircut_likes_one_per_user on public.haircut_likes (haircut_id, user_id);

alter table public.haircut_likes enable row level security;
select public.reset_policies('public.haircut_likes');

create policy "likes: read own likes" on public.haircut_likes
    for select to authenticated
    using (user_id = (select auth.uid()));

create policy "likes: add own like on a published photo" on public.haircut_likes
    for insert to authenticated
    with check (
        user_id = (select auth.uid())
        and exists (select 1 from public.haircuts h where h.id = haircut_id and h.is_published)
    );

create policy "likes: remove own like" on public.haircut_likes
    for delete to authenticated
    using (user_id = (select auth.uid()));

revoke all on public.haircut_likes from anon, authenticated;
grant select, delete on public.haircut_likes to authenticated;
grant insert (haircut_id) on public.haircut_likes to authenticated;

-- Public gallery with like counts, without exposing who liked what.
create or replace function public.gallery_with_likes()
returns table (
    id uuid,
    title_fr text,
    title_ar text,
    desc_fr text,
    desc_ar text,
    image_url text,
    category text,
    sort_order integer,
    like_count bigint,
    liked_by_me boolean
)
language sql
stable
security definer
set search_path = ''
as $$
    select h.id, h.title_fr, h.title_ar, h.desc_fr, h.desc_ar, h.image_url, h.category, h.sort_order,
           count(l.id) as like_count,
           coalesce(bool_or(l.user_id = (select auth.uid())), false) as liked_by_me
    from public.haircuts h
    left join public.haircut_likes l on l.haircut_id = h.id
    where h.is_published
    group by h.id
    order by h.sort_order, h.created_at desc;
$$;

revoke all on function public.gallery_with_likes() from public;
grant execute on function public.gallery_with_likes() to anon, authenticated;

commit;


-- ===== 20261030130000_revoke_internal_functions.sql =====
-- ZEYD BARBER — hide internal helper functions from the API
-- Supabase grants EXECUTE on new functions to anon and authenticated explicitly, so the
-- "revoke ... from public" of the previous migration was not enough: anonymous visitors could
-- call /rest/v1/rpc/reset_policies (it then failed on permissions, but it must not be reachable).
-- Re-running this file is harmless.

begin;

revoke execute on function public.reset_policies(regclass) from public, anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.set_updated_at() from public, anon, authenticated;

commit;


-- ===== 20261030140000_phase3_booking.sql =====
-- ZEYD BARBER — Phase 3: booking system
-- Opening hours, closures, booking settings and bookings, with every rule enforced in the database:
-- customers can only book through book_appointment(), which checks hours, closures, notice, horizon and
-- slot alignment; an exclusion constraint makes two confirmed bookings overlapping impossible, even
-- when two customers click at the same moment. One chair (only Zeyd): no overlap at all.
--
-- Decisions (2026-10-30): open Monday, Friday, Saturday 09:00–12:00 and 14:00–19:00; bookings are
-- confirmed automatically; an account is required. Times are computed in Europe/Paris.
-- Safe on a fresh project and on the prototype public.bookings table (columns added, nothing dropped).

begin;

-- ---------------------------------------------------------------------------
-- Settings (single row, editable by staff)
-- ---------------------------------------------------------------------------
create table if not exists public.booking_settings (
    id boolean primary key default true check (id),
    timezone text not null default 'Europe/Paris',
    slot_step_minutes integer not null default 15 check (slot_step_minutes between 5 and 60),
    min_notice_minutes integer not null default 60 check (min_notice_minutes >= 0),
    max_days_ahead integer not null default 30 check (max_days_ahead between 1 and 365),
    cancel_notice_minutes integer not null default 120 check (cancel_notice_minutes >= 0),
    max_active_bookings integer not null default 2 check (max_active_bookings >= 1),
    updated_at timestamptz not null default now()
);

insert into public.booking_settings (id) values (true) on conflict (id) do nothing;

drop trigger if exists booking_settings_set_updated_at on public.booking_settings;
create trigger booking_settings_set_updated_at
    before update on public.booking_settings
    for each row execute function public.set_updated_at();

alter table public.booking_settings enable row level security;
select public.reset_policies('public.booking_settings');

create policy "booking_settings: public read" on public.booking_settings
    for select to anon, authenticated
    using (true);

create policy "booking_settings: staff update" on public.booking_settings
    for update to authenticated
    using ((select public.is_staff()))
    with check ((select public.is_staff()));

revoke all on public.booking_settings from anon, authenticated;
grant select on public.booking_settings to anon, authenticated;
grant update on public.booking_settings to authenticated;

-- ---------------------------------------------------------------------------
-- Opening hours: one row per open segment; the gap between segments is the break
-- ---------------------------------------------------------------------------
create table if not exists public.business_hours (
    id uuid primary key default gen_random_uuid(),
    weekday smallint not null check (weekday between 1 and 7), -- ISO: 1 = Monday … 7 = Sunday
    opens_at time not null,
    closes_at time not null,
    check (opens_at < closes_at),
    unique (weekday, opens_at)
);

-- Seed only an empty table, so hours edited later by staff are never overwritten.
insert into public.business_hours (weekday, opens_at, closes_at)
select v.weekday, v.opens_at::time, v.closes_at::time
from (
    values
        (1, '09:00', '12:00'), (1, '14:00', '19:00'),
        (5, '09:00', '12:00'), (5, '14:00', '19:00'),
        (6, '09:00', '12:00'), (6, '14:00', '19:00')
) as v (weekday, opens_at, closes_at)
where not exists (select 1 from public.business_hours);

alter table public.business_hours enable row level security;
select public.reset_policies('public.business_hours');

create policy "business_hours: public read" on public.business_hours
    for select to anon, authenticated
    using (true);

create policy "business_hours: staff write" on public.business_hours
    for all to authenticated
    using ((select public.is_staff()))
    with check ((select public.is_staff()));

revoke all on public.business_hours from anon, authenticated;
grant select on public.business_hours to anon, authenticated;
grant insert, update, delete on public.business_hours to authenticated;

-- ---------------------------------------------------------------------------
-- Closures (holidays, exceptional days off), inclusive dates in salon time
-- ---------------------------------------------------------------------------
create table if not exists public.closures (
    id uuid primary key default gen_random_uuid(),
    starts_on date not null,
    ends_on date not null,
    reason text,
    created_at timestamptz not null default now(),
    check (starts_on <= ends_on)
);

alter table public.closures enable row level security;
select public.reset_policies('public.closures');

create policy "closures: public read" on public.closures
    for select to anon, authenticated
    using (true);

create policy "closures: staff write" on public.closures
    for all to authenticated
    using ((select public.is_staff()))
    with check ((select public.is_staff()));

revoke all on public.closures from anon, authenticated;
grant select on public.closures to anon, authenticated;
grant insert, update, delete on public.closures to authenticated;

-- ---------------------------------------------------------------------------
-- Bookings
-- Status: confirmed (normal booking) · requested (custom time, waiting for the barber)
--         cancelled · completed · no_show
-- ---------------------------------------------------------------------------
create table if not exists public.bookings (
    id uuid primary key default gen_random_uuid(),
    customer_id uuid not null references public.profiles (id) on delete cascade,
    service_id uuid not null references public.services (id),
    status text not null default 'confirmed',
    created_at timestamptz not null default now()
);

alter table public.bookings add column if not exists starts_at timestamptz;
alter table public.bookings add column if not exists ends_at timestamptz;
alter table public.bookings add column if not exists is_custom_request boolean not null default false;
alter table public.bookings add column if not exists customer_note text;
alter table public.bookings add column if not exists cancelled_at timestamptz;
alter table public.bookings add column if not exists cancelled_by uuid references auth.users (id) on delete set null;
alter table public.bookings add column if not exists updated_at timestamptz not null default now();
alter table public.bookings alter column status set default 'confirmed';

-- Prototype columns, replaced by starts_at / ends_at: keep them, but no longer required.
do $$
declare
    col text;
begin
    foreach col in array array['booking_date', 'booking_time', 'is_custom_time'] loop
        if exists (
            select 1 from information_schema.columns
            where table_schema = 'public' and table_name = 'bookings' and column_name = col
        ) then
            execute format('alter table public.bookings alter column %I drop not null', col);
        end if;
    end loop;
end;
$$;

do $$
begin
    -- NOT VALID: prototype rows (if any) keep their old status; every new or changed row is checked.
    if not exists (select 1 from pg_constraint where conname = 'bookings_status_check') then
        alter table public.bookings add constraint bookings_status_check
            check (status in ('requested', 'confirmed', 'cancelled', 'completed', 'no_show')) not valid;
    end if;
    if not exists (select 1 from pg_constraint where conname = 'bookings_time_order_check') then
        alter table public.bookings add constraint bookings_time_order_check check (ends_at > starts_at);
    end if;
    if not exists (select 1 from pg_constraint where conname = 'bookings_note_length_check') then
        alter table public.bookings add constraint bookings_note_length_check
            check (char_length(customer_note) <= 300);
    end if;
    -- The double-booking guard: no two confirmed bookings may overlap, ever.
    if not exists (select 1 from pg_constraint where conname = 'bookings_no_overlap') then
        alter table public.bookings add constraint bookings_no_overlap
            exclude using gist (tstzrange(starts_at, ends_at, '[)') with &&)
            where (status = 'confirmed' and starts_at is not null and ends_at is not null);
    end if;
end;
$$;

create index if not exists bookings_customer_starts_idx on public.bookings (customer_id, starts_at);

drop trigger if exists bookings_set_updated_at on public.bookings;
create trigger bookings_set_updated_at
    before update on public.bookings
    for each row execute function public.set_updated_at();

alter table public.bookings enable row level security;
select public.reset_policies('public.bookings');

-- Reading only. Every change goes through the functions below.
create policy "bookings: read own or staff" on public.bookings
    for select to authenticated
    using (customer_id = (select auth.uid()) or (select public.is_staff()));

revoke all on public.bookings from anon, authenticated;
grant select on public.bookings to authenticated;

-- ---------------------------------------------------------------------------
-- Availability (public: returns times only, never who booked)
-- ---------------------------------------------------------------------------
create or replace function public.bookable_days()
returns table (day date)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    s public.booking_settings;
    today date;
begin
    select * into s from public.booking_settings bs where bs.id;
    today := (now() at time zone s.timezone)::date;
    return query
        select d::date
        from generate_series(today, today + s.max_days_ahead, interval '1 day') as d
        where exists (select 1 from public.business_hours h where h.weekday = extract(isodow from d))
          and not exists (select 1 from public.closures c where d::date between c.starts_on and c.ends_on)
        order by 1;
end;
$$;

create or replace function public.available_slots(p_service_id uuid, p_day date)
returns table (starts_at timestamptz, ends_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    s public.booking_settings;
    duration interval;
    today date;
begin
    select * into s from public.booking_settings bs where bs.id;
    select make_interval(mins => sv.duration_minutes) into duration
    from public.services sv
    where sv.id = p_service_id and sv.is_active and sv.duration_minutes is not null;

    today := (now() at time zone s.timezone)::date;
    if duration is null
        or p_day is null
        or p_day < today
        or p_day > today + s.max_days_ahead
        or exists (select 1 from public.closures c where p_day between c.starts_on and c.ends_on)
    then
        return;
    end if;

    return query
        select slot.st, slot.st + duration
        from public.business_hours h
        cross join lateral generate_series(
            p_day + h.opens_at,
            p_day + h.closes_at - duration,
            make_interval(mins => s.slot_step_minutes)
        ) as g (local_start)
        cross join lateral (select g.local_start at time zone s.timezone as st) as slot
        where h.weekday = extract(isodow from p_day)
          and slot.st >= now() + make_interval(mins => s.min_notice_minutes)
          and not exists (
              select 1 from public.bookings b
              where b.status = 'confirmed'
                and b.starts_at is not null
                and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(slot.st, slot.st + duration, '[)')
          )
        order by 1;
end;
$$;

-- ---------------------------------------------------------------------------
-- Customer actions. Errors are raised with a short code as message, translated by the site:
-- auth_required, service_unavailable, slot_unavailable, too_many_bookings, invalid_time,
-- not_found, too_late_to_cancel, invalid_status, forbidden
-- ---------------------------------------------------------------------------
create or replace function public.check_can_book(p_customer uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    s public.booking_settings;
begin
    if p_customer is null or not exists (select 1 from public.profiles pr where pr.id = p_customer) then
        raise exception 'auth_required';
    end if;
    select * into s from public.booking_settings bs where bs.id;
    -- One customer books at a time: makes the limit below exact under concurrency.
    perform pg_advisory_xact_lock(hashtext('booking:' || p_customer::text));
    if (
        select count(*) from public.bookings b
        where b.customer_id = p_customer
          and b.status in ('confirmed', 'requested')
          and b.starts_at > now()
    ) >= s.max_active_bookings then
        raise exception 'too_many_bookings';
    end if;
end;
$$;

create or replace function public.book_appointment(p_service_id uuid, p_starts_at timestamptz, p_note text default null)
returns table (id uuid, starts_at timestamptz, ends_at timestamptz, status text)
language plpgsql
security definer
set search_path = ''
as $$
declare
    s public.booking_settings;
    uid uuid := auth.uid();
    slot_end timestamptz;
    new_id uuid;
begin
    perform public.check_can_book(uid);
    select * into s from public.booking_settings bs where bs.id;

    if not exists (
        select 1 from public.services sv
        where sv.id = p_service_id and sv.is_active and sv.duration_minutes is not null
    ) then
        raise exception 'service_unavailable';
    end if;

    -- The requested start must be one of the slots offered: this applies every rule at once
    -- (open day, opening hours, break, closures, notice, horizon, 15-minute grid, free chair).
    select a.ends_at into slot_end
    from public.available_slots(p_service_id, (p_starts_at at time zone s.timezone)::date) as a
    where a.starts_at = p_starts_at;

    if slot_end is null then
        raise exception 'slot_unavailable';
    end if;

    begin
        insert into public.bookings (customer_id, service_id, starts_at, ends_at, status, customer_note)
        values (uid, p_service_id, p_starts_at, slot_end, 'confirmed', nullif(trim(p_note), ''))
        returning bookings.id into new_id;
    exception
        when exclusion_violation then
            -- Someone else took the slot a moment earlier
            raise exception 'slot_unavailable';
    end;

    return query select new_id, p_starts_at, slot_end, 'confirmed'::text;
end;
$$;

-- A time outside the normal grid (e.g. 18:45 or a closed day): stored as a request that does not
-- block any slot until the barber confirms it.
create or replace function public.request_custom_time(p_service_id uuid, p_starts_at timestamptz, p_note text default null)
returns table (id uuid, starts_at timestamptz, status text)
language plpgsql
security definer
set search_path = ''
as $$
declare
    s public.booking_settings;
    uid uuid := auth.uid();
    duration_minutes integer;
    new_id uuid;
begin
    perform public.check_can_book(uid);
    select * into s from public.booking_settings bs where bs.id;

    select sv.duration_minutes into duration_minutes
    from public.services sv
    where sv.id = p_service_id and sv.is_active;
    if not found then
        raise exception 'service_unavailable';
    end if;

    if p_starts_at is null
        or p_starts_at < now() + make_interval(mins => s.min_notice_minutes)
        or (p_starts_at at time zone s.timezone)::date > (now() at time zone s.timezone)::date + s.max_days_ahead
    then
        raise exception 'invalid_time';
    end if;

    insert into public.bookings (customer_id, service_id, starts_at, ends_at, status, is_custom_request, customer_note)
    values (
        uid,
        p_service_id,
        p_starts_at,
        p_starts_at + make_interval(mins => duration_minutes), -- null when the duration is unknown
        'requested',
        true,
        nullif(trim(p_note), '')
    )
    returning bookings.id into new_id;

    return query select new_id, p_starts_at, 'requested'::text;
end;
$$;

create or replace function public.cancel_booking(p_booking_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    s public.booking_settings;
    uid uuid := auth.uid();
    b public.bookings;
    staff boolean := public.is_staff();
begin
    if uid is null then
        raise exception 'auth_required';
    end if;
    select * into s from public.booking_settings bs where bs.id;
    select * into b from public.bookings where bookings.id = p_booking_id for update;

    if not found or (b.customer_id <> uid and not staff) then
        raise exception 'not_found';
    end if;
    if b.status not in ('confirmed', 'requested') then
        raise exception 'invalid_status';
    end if;
    if not staff and b.starts_at < now() + make_interval(mins => s.cancel_notice_minutes) then
        raise exception 'too_late_to_cancel';
    end if;

    update public.bookings
    set status = 'cancelled', cancelled_at = now(), cancelled_by = uid
    where bookings.id = p_booking_id;
end;
$$;

-- Staff only: confirm a custom request, mark a visit completed / no-show, or cancel.
create or replace function public.set_booking_status(
    p_booking_id uuid,
    p_status text,
    p_ends_at timestamptz default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    b public.bookings;
begin
    if not public.is_staff() then
        raise exception 'forbidden';
    end if;
    select * into b from public.bookings where bookings.id = p_booking_id for update;
    if not found then
        raise exception 'not_found';
    end if;

    if p_status = 'confirmed' and b.status = 'requested' then
        begin
            update public.bookings
            set status = 'confirmed', ends_at = coalesce(p_ends_at, b.ends_at)
            where bookings.id = p_booking_id;
        exception
            when exclusion_violation then
                raise exception 'slot_unavailable';
        end;
        if (select ends_at from public.bookings where bookings.id = p_booking_id) is null then
            raise exception 'invalid_time'; -- the end time is needed to block the chair
        end if;
    elsif p_status = 'cancelled' and b.status in ('requested', 'confirmed') then
        update public.bookings
        set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid()
        where bookings.id = p_booking_id;
    elsif p_status in ('completed', 'no_show') and b.status = 'confirmed' and b.starts_at <= now() then
        update public.bookings set status = p_status where bookings.id = p_booking_id;
    else
        raise exception 'invalid_status';
    end if;
end;
$$;

-- Who may call what. Supabase grants EXECUTE to anon/authenticated explicitly, so revoke from them too.
revoke all on function public.check_can_book(uuid) from public, anon, authenticated;
revoke all on function public.bookable_days() from public;
revoke all on function public.available_slots(uuid, date) from public;
revoke all on function public.book_appointment(uuid, timestamptz, text) from public, anon;
revoke all on function public.request_custom_time(uuid, timestamptz, text) from public, anon;
revoke all on function public.cancel_booking(uuid) from public, anon;
revoke all on function public.set_booking_status(uuid, text, timestamptz) from public, anon;

grant execute on function public.bookable_days() to anon, authenticated;
grant execute on function public.available_slots(uuid, date) to anon, authenticated;
grant execute on function public.book_appointment(uuid, timestamptz, text) to authenticated;
grant execute on function public.request_custom_time(uuid, timestamptz, text) to authenticated;
grant execute on function public.cancel_booking(uuid) to authenticated;
grant execute on function public.set_booking_status(uuid, text, timestamptz) to authenticated;

commit;


-- ===== 20261031090000_phase3_custom_time_gap.sql =====
-- ZEYD BARBER — Phase 3 (part 2): custom times follow the same rules as normal slots
-- 1. A custom time ("I'll come at 16:20") is refused when it is less than one cut (35 min by
--    default) away from another booking, outside opening hours, during the break or on a closed day.
--    Example: Monday 16:00 is booked → 16:15 is refused (too_close), 16:35 is accepted.
-- 2. A valid custom time is confirmed at once (bookings are confirmed automatically). When the
--    service duration is unknown it stays "requested" but already holds the chair for 35 min.
-- 3. Staff can cancel with a reason, and switch online booking off (holidays).
-- Applied after 20261030140000_phase3_booking.sql. Nothing is dropped except one constraint, which is
-- re-created at once in a stricter form (requested bookings now hold the chair too).

begin;

alter table public.booking_settings
    add column if not exists min_gap_minutes integer not null default 35 check (min_gap_minutes between 5 and 240);
alter table public.booking_settings add column if not exists booking_enabled boolean not null default true;

alter table public.bookings add column if not exists cancel_reason text;
do $$
begin
    if not exists (select 1 from pg_constraint where conname = 'bookings_cancel_reason_length_check') then
        alter table public.bookings add constraint bookings_cancel_reason_length_check
            check (char_length(cancel_reason) <= 500);
    end if;
end;
$$;

-- Requested bookings hold the chair as well: no two of them (or a confirmed one) may overlap.
alter table public.bookings drop constraint if exists bookings_no_overlap;
alter table public.bookings add constraint bookings_no_overlap
    exclude using gist (tstzrange(starts_at, ends_at, '[)') with &&)
    where (status in ('confirmed', 'requested') and starts_at is not null and ends_at is not null);

-- ---------------------------------------------------------------------------
-- Internal helpers
-- ---------------------------------------------------------------------------
-- True when [p_start, p_end) lies inside one opening segment of an open, non-closed day (salon time).
create or replace function public.fits_opening_hours(p_start timestamptz, p_end timestamptz)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    tz text;
    local_start timestamp;
    local_end timestamp;
    day date;
begin
    select bs.timezone into tz from public.booking_settings bs where bs.id;
    local_start := p_start at time zone tz;
    local_end := p_end at time zone tz;
    day := local_start::date;
    if local_end::date <> day and local_end <> day + 1 then
        return false;
    end if;
    if exists (select 1 from public.closures c where day between c.starts_on and c.ends_on) then
        return false;
    end if;
    return exists (
        select 1 from public.business_hours h
        where h.weekday = extract(isodow from day)
          and local_start >= day + h.opens_at
          and local_end <= day + h.closes_at
    );
end;
$$;

-- True when [p_start, p_end) overlaps a booking that holds the chair.
create or replace function public.chair_is_taken(p_start timestamptz, p_end timestamptz)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select exists (
        select 1
        from public.bookings b
        cross join public.booking_settings bs
        where bs.id
          and b.status in ('confirmed', 'requested')
          and b.starts_at is not null
          and tstzrange(b.starts_at, coalesce(b.ends_at, b.starts_at + make_interval(mins => bs.min_gap_minutes)), '[)')
              && tstzrange(p_start, p_end, '[)')
    );
$$;

-- ---------------------------------------------------------------------------
-- Availability: respects booking_enabled and requested bookings
-- ---------------------------------------------------------------------------
create or replace function public.bookable_days()
returns table (day date)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    s public.booking_settings;
    today date;
begin
    select * into s from public.booking_settings bs where bs.id;
    if not s.booking_enabled then
        return;
    end if;
    today := (now() at time zone s.timezone)::date;
    return query
        select d::date
        from generate_series(today, today + s.max_days_ahead, interval '1 day') as d
        where exists (select 1 from public.business_hours h where h.weekday = extract(isodow from d))
          and not exists (select 1 from public.closures c where d::date between c.starts_on and c.ends_on)
        order by 1;
end;
$$;

create or replace function public.available_slots(p_service_id uuid, p_day date)
returns table (starts_at timestamptz, ends_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    s public.booking_settings;
    duration interval;
    today date;
begin
    select * into s from public.booking_settings bs where bs.id;
    select make_interval(mins => sv.duration_minutes) into duration
    from public.services sv
    where sv.id = p_service_id and sv.is_active and sv.duration_minutes is not null;

    today := (now() at time zone s.timezone)::date;
    if not s.booking_enabled
        or duration is null
        or p_day is null
        or p_day < today
        or p_day > today + s.max_days_ahead
        or exists (select 1 from public.closures c where p_day between c.starts_on and c.ends_on)
    then
        return;
    end if;

    return query
        select slot.st, slot.st + duration
        from public.business_hours h
        cross join lateral generate_series(
            p_day + h.opens_at,
            p_day + h.closes_at - duration,
            make_interval(mins => s.slot_step_minutes)
        ) as g (local_start)
        cross join lateral (select g.local_start at time zone s.timezone as st) as slot
        where h.weekday = extract(isodow from p_day)
          and slot.st >= now() + make_interval(mins => s.min_notice_minutes)
          and not public.chair_is_taken(slot.st, slot.st + duration)
        order by 1;
end;
$$;

create or replace function public.check_can_book(p_customer uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    s public.booking_settings;
begin
    if p_customer is null or not exists (select 1 from public.profiles pr where pr.id = p_customer) then
        raise exception 'auth_required';
    end if;
    select * into s from public.booking_settings bs where bs.id;
    if not s.booking_enabled then
        raise exception 'booking_disabled';
    end if;
    -- One customer books at a time: makes the limit below exact under concurrency.
    perform pg_advisory_xact_lock(hashtext('booking:' || p_customer::text));
    if (
        select count(*) from public.bookings b
        where b.customer_id = p_customer
          and b.status in ('confirmed', 'requested')
          and b.starts_at > now()
    ) >= s.max_active_bookings then
        raise exception 'too_many_bookings';
    end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Custom time: same rules as a slot except the 15-minute grid
-- Errors: invalid_time (past, too soon, too far), outside_hours (closed day, break, after closing),
--         too_close (less than one cut away from another booking)
-- ---------------------------------------------------------------------------
create or replace function public.request_custom_time(p_service_id uuid, p_starts_at timestamptz, p_note text default null)
returns table (id uuid, starts_at timestamptz, status text)
language plpgsql
security definer
set search_path = ''
as $$
declare
    s public.booking_settings;
    uid uuid := auth.uid();
    service_minutes integer;
    block_end timestamptz;
    new_status text;
    new_id uuid;
begin
    perform public.check_can_book(uid);
    select * into s from public.booking_settings bs where bs.id;

    select sv.duration_minutes into service_minutes
    from public.services sv
    where sv.id = p_service_id and sv.is_active;
    if not found then
        raise exception 'service_unavailable';
    end if;

    if p_starts_at is null
        or p_starts_at < now() + make_interval(mins => s.min_notice_minutes)
        or (p_starts_at at time zone s.timezone)::date > (now() at time zone s.timezone)::date + s.max_days_ahead
    then
        raise exception 'invalid_time';
    end if;

    -- Unknown duration: hold the chair for one standard cut until the barber confirms.
    block_end := p_starts_at + make_interval(mins => coalesce(service_minutes, s.min_gap_minutes));

    if not public.fits_opening_hours(p_starts_at, block_end) then
        raise exception 'outside_hours';
    end if;
    if public.chair_is_taken(p_starts_at, block_end) then
        raise exception 'too_close';
    end if;

    new_status := case when service_minutes is null then 'requested' else 'confirmed' end;
    begin
        insert into public.bookings
            (customer_id, service_id, starts_at, ends_at, status, is_custom_request, customer_note)
        values (uid, p_service_id, p_starts_at, block_end, new_status, true, nullif(trim(p_note), ''))
        returning bookings.id into new_id;
    exception
        when exclusion_violation then
            raise exception 'too_close'; -- someone took a neighbouring time a moment earlier
    end;

    return query select new_id, p_starts_at, new_status;
end;
$$;

-- ---------------------------------------------------------------------------
-- Staff: cancel with a reason. Returns what is needed to write to the customer.
-- ---------------------------------------------------------------------------
create or replace function public.staff_cancel_booking(p_booking_id uuid, p_reason text default null)
returns table (
    customer_email text,
    customer_name text,
    customer_lang text,
    starts_at timestamptz,
    service_name_fr text,
    service_name_ar text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
    b public.bookings;
begin
    if not public.is_staff() then
        raise exception 'forbidden';
    end if;
    select * into b from public.bookings where bookings.id = p_booking_id for update;
    if not found then
        raise exception 'not_found';
    end if;
    if b.status not in ('confirmed', 'requested') then
        raise exception 'invalid_status';
    end if;

    update public.bookings
    set status = 'cancelled',
        cancelled_at = now(),
        cancelled_by = auth.uid(),
        cancel_reason = nullif(trim(p_reason), '')
    where bookings.id = p_booking_id;

    return query
        select p.email, p.full_name, p.preferred_lang, b.starts_at, sv.name_fr, sv.name_ar
        from public.profiles p
        cross join public.services sv
        where p.id = b.customer_id and sv.id = b.service_id;
end;
$$;

revoke all on function public.fits_opening_hours(timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.chair_is_taken(timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.check_can_book(uuid) from public, anon, authenticated;
revoke all on function public.staff_cancel_booking(uuid, text) from public, anon;
grant execute on function public.staff_cancel_booking(uuid, text) to authenticated;

commit;


-- ===== 20261031100000_phase4_admin.sql =====
-- ZEYD BARBER — Phase 4: admin / barber dashboard (admin.html)
-- Most dashboard actions already rely on the RLS policies of Phases 2–3 (staff may edit services,
-- hours, closures, settings, gallery, and read bookings and profiles). This file adds:
--   * set_user_role(): the only way to change a role, admins only, never one's own role;
--   * the "gallery" storage bucket for haircut photos, writable by staff only;
--   * admin-only settings: only an admin may change booking_settings.

begin;

-- ---------------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------------
create or replace function public.set_user_role(p_user_id uuid, p_role text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
    if not public.is_admin() then
        raise exception 'forbidden';
    end if;
    if p_role not in ('customer', 'barber', 'admin') then
        raise exception 'invalid_role';
    end if;
    if p_user_id = auth.uid() then
        -- Prevents an admin from locking everyone out by demoting themself
        raise exception 'cannot_change_own_role';
    end if;
    update public.profiles set role = p_role where id = p_user_id;
    if not found then
        raise exception 'not_found';
    end if;
end;
$$;

revoke all on function public.set_user_role(uuid, text) from public, anon;
grant execute on function public.set_user_role(uuid, text) to authenticated;

-- Settings: admins only (barbers manage bookings, hours, services and photos)
drop policy if exists "booking_settings: staff update" on public.booking_settings;
drop policy if exists "booking_settings: admin update" on public.booking_settings;
create policy "booking_settings: admin update" on public.booking_settings
    for update to authenticated
    using ((select public.is_admin()))
    with check ((select public.is_admin()));

-- ---------------------------------------------------------------------------
-- Gallery photos: public bucket (anyone can view a published photo URL), staff-only writes
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('gallery', 'gallery', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

drop policy if exists "gallery: staff read" on storage.objects;
drop policy if exists "gallery: staff upload" on storage.objects;
drop policy if exists "gallery: staff update" on storage.objects;
drop policy if exists "gallery: staff delete" on storage.objects;

create policy "gallery: staff read" on storage.objects
    for select to authenticated
    using (bucket_id = 'gallery' and (select public.is_staff()));

create policy "gallery: staff upload" on storage.objects
    for insert to authenticated
    with check (bucket_id = 'gallery' and (select public.is_staff()));

create policy "gallery: staff update" on storage.objects
    for update to authenticated
    using (bucket_id = 'gallery' and (select public.is_staff()))
    with check (bucket_id = 'gallery' and (select public.is_staff()));

create policy "gallery: staff delete" on storage.objects
    for delete to authenticated
    using (bucket_id = 'gallery' and (select public.is_staff()));

commit;


-- ===== 20261031110000_phase5_loyalty.sql =====
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


-- ===== 20261031120000_payments.sql =====
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


-- ===== 20261101090000_phase6_cancellations.sql =====
-- Phase 6 / stage B: customer cancellation with a reason, safe rescheduling, booking history (audit) and a
-- notification queue for Zeyd (Telegram is sent by the notify-staff Edge Function, never from the browser).
-- New migration: nothing already applied is re-run. Safe to run twice.
begin;

-- ---------------------------------------------------------------------------
-- Bookings: why it was cancelled, and which booking a rescheduled one replaces
-- ---------------------------------------------------------------------------
alter table public.bookings add column if not exists cancel_reason_code text;
alter table public.bookings add column if not exists cancel_details text;
alter table public.bookings add column if not exists rescheduled_from uuid references public.bookings (id) on delete set null;

do $$
begin
    if not exists (select 1 from pg_constraint where conname = 'bookings_cancel_reason_code_check') then
        alter table public.bookings add constraint bookings_cancel_reason_code_check check (
            cancel_reason_code is null
            or cancel_reason_code in ('reschedule', 'unavailable', 'time_unsuitable', 'dissatisfied', 'price_service', 'other')
        );
    end if;
    if not exists (select 1 from pg_constraint where conname = 'bookings_cancel_details_length_check') then
        alter table public.bookings add constraint bookings_cancel_details_length_check
            check (cancel_details is null or char_length(cancel_details) <= 500);
    end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Booking history: every creation and status change, who did it and why (staff only)
-- ---------------------------------------------------------------------------
create table if not exists public.booking_events (
    id uuid primary key default gen_random_uuid(),
    booking_id uuid not null references public.bookings (id) on delete cascade,
    action text not null check (action in ('created', 'confirmed', 'cancelled', 'completed', 'no_show', 'rescheduled')),
    actor_id uuid references auth.users (id) on delete set null,
    by_customer boolean not null default false,
    reason_code text,
    details text,
    created_at timestamptz not null default now()
);

create index if not exists booking_events_booking_idx on public.booking_events (booking_id, created_at);
create index if not exists booking_events_recent_idx on public.booking_events (created_at desc);

-- ---------------------------------------------------------------------------
-- Staff notifications: payments (existing) + cancellations, reschedulings, rewards, payment issues.
-- telegram_status tracks the message to Zeyd: pending → sending → sent | failed | not_configured.
-- ---------------------------------------------------------------------------
alter table public.staff_notifications drop constraint if exists staff_notifications_kind_check;
alter table public.staff_notifications add constraint staff_notifications_kind_check
    check (kind in ('payment', 'cancellation', 'reschedule', 'reward', 'payment_issue'));
alter table public.staff_notifications alter column amount_cents drop not null;
alter table public.staff_notifications add column if not exists booking_id uuid references public.bookings (id) on delete cascade;
alter table public.staff_notifications add column if not exists data jsonb not null default '{}'::jsonb;
alter table public.staff_notifications add column if not exists telegram_status text;
alter table public.staff_notifications add column if not exists telegram_error text;
alter table public.staff_notifications add column if not exists telegram_claimed_at timestamptz;
alter table public.staff_notifications add column if not exists telegram_sent_at timestamptz;
alter table public.staff_notifications add column if not exists telegram_attempts integer not null default 0;

do $$
begin
    if not exists (select 1 from pg_constraint where conname = 'staff_notifications_telegram_status_check') then
        alter table public.staff_notifications add constraint staff_notifications_telegram_status_check
            check (telegram_status is null or telegram_status in ('pending', 'sending', 'sent', 'failed', 'not_configured'));
    end if;
end;
$$;

-- One notification per booking and kind: a refresh or a double click never creates a second one
create unique index if not exists staff_notifications_one_per_booking
    on public.staff_notifications (kind, booking_id) where booking_id is not null;

-- ---------------------------------------------------------------------------
-- Trigger: history + notification, for every path that changes a booking (old and new functions alike)
-- ---------------------------------------------------------------------------
create or replace function public.log_booking_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    uid uuid := auth.uid();
    customer boolean;
    action text;
begin
    if tg_op = 'INSERT' then
        insert into public.booking_events (booking_id, action, actor_id, by_customer)
        values (new.id, 'created', uid, uid is not distinct from new.customer_id);
        return new;
    end if;

    if new.status is not distinct from old.status then
        return new;
    end if;
    customer := uid is not null and uid = new.customer_id;
    action := case when new.status = 'requested' then 'created' else new.status end;
    insert into public.booking_events (booking_id, action, actor_id, by_customer, reason_code, details)
    values (
        new.id, action, uid, customer,
        case when new.status = 'cancelled' then new.cancel_reason_code end,
        case when new.status = 'cancelled' then coalesce(new.cancel_details, new.cancel_reason) end
    );

    -- Cancelled by the customer: Zeyd is told (dashboard always, Telegram if configured)
    if new.status = 'cancelled' and customer then
        insert into public.staff_notifications (kind, booking_id, data, telegram_status)
        select
            case when new.cancel_reason_code = 'reschedule' then 'reschedule' else 'cancellation' end,
            new.id,
            jsonb_build_object(
                'customer_name', p.full_name,
                'starts_at', new.starts_at,
                'service_fr', sv.name_fr,
                'service_ar', sv.name_ar,
                'reason_code', new.cancel_reason_code,
                'details', new.cancel_details
            ),
            'pending'
        from public.profiles p
        left join public.services sv on sv.id = new.service_id
        where p.id = new.customer_id
        on conflict do nothing;
    end if;
    return new;
end;
$$;

drop trigger if exists bookings_log_event on public.bookings;
create trigger bookings_log_event
    after insert or update of status on public.bookings
    for each row execute function public.log_booking_event();

-- ---------------------------------------------------------------------------
-- Customer: cancel one's own booking, with a reason
-- ---------------------------------------------------------------------------
create or replace function public.cancel_my_booking(p_booking_id uuid, p_reason_code text, p_details text default null)
returns table (id uuid, status text, cancelled_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
    s public.booking_settings;
    uid uuid := auth.uid();
    b public.bookings;
    details text := nullif(trim(p_details), '');
begin
    if uid is null then
        raise exception 'auth_required';
    end if;
    if p_reason_code is null
        or p_reason_code not in ('reschedule', 'unavailable', 'time_unsuitable', 'dissatisfied', 'price_service', 'other') then
        raise exception 'invalid_reason';
    end if;
    if char_length(details) > 500 then
        raise exception 'details_too_long';
    end if;
    if p_reason_code = 'other' and details is null then
        raise exception 'details_required';
    end if;

    select * into s from public.booking_settings bs where bs.id;
    select * into b from public.bookings bk where bk.id = p_booking_id for update;
    -- Someone else's booking looks exactly like a missing one
    if not found or b.customer_id <> uid then
        raise exception 'not_found';
    end if;
    -- Already cancelled (second click, second tab): refused, so nothing happens twice
    if b.status not in ('confirmed', 'requested') then
        raise exception 'invalid_status';
    end if;
    if b.starts_at < now() + make_interval(mins => s.cancel_notice_minutes) then
        raise exception 'too_late_to_cancel';
    end if;

    update public.bookings bk
    set status = 'cancelled', cancelled_at = now(), cancelled_by = uid,
        cancel_reason_code = p_reason_code, cancel_details = details
    where bk.id = p_booking_id;

    return query select bk.id, bk.status, bk.cancelled_at from public.bookings bk where bk.id = p_booking_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Customer: move one's own booking to another free slot, all or nothing.
-- The old booking is cancelled and the new one booked in the same transaction: if the new slot is not
-- available (taken a moment earlier, outside the hours, too close…), nothing changes and the old one stays.
-- ---------------------------------------------------------------------------
create or replace function public.reschedule_my_booking(p_booking_id uuid, p_new_starts_at timestamptz, p_details text default null)
returns table (id uuid, starts_at timestamptz, ends_at timestamptz, status text)
language plpgsql
security definer
set search_path = ''
as $$
declare
    s public.booking_settings;
    uid uuid := auth.uid();
    b public.bookings;
    details text := nullif(trim(p_details), '');
    new_id uuid;
    new_start timestamptz;
    new_end timestamptz;
begin
    if uid is null then
        raise exception 'auth_required';
    end if;
    if char_length(details) > 500 then
        raise exception 'details_too_long';
    end if;
    select * into s from public.booking_settings bs where bs.id;
    select * into b from public.bookings bk where bk.id = p_booking_id for update;
    if not found or b.customer_id <> uid then
        raise exception 'not_found';
    end if;
    if b.status <> 'confirmed' then
        raise exception 'invalid_status';
    end if;
    if b.starts_at < now() + make_interval(mins => s.cancel_notice_minutes) then
        raise exception 'too_late_to_cancel';
    end if;
    if p_new_starts_at = b.starts_at then
        raise exception 'same_time';
    end if;

    update public.bookings bk
    set status = 'cancelled', cancelled_at = now(), cancelled_by = uid,
        cancel_reason_code = 'reschedule', cancel_details = details
    where bk.id = p_booking_id;

    -- Same rules as a normal booking (slot offered, free chair, limits); any error undoes the cancellation
    select r.id, r.starts_at, r.ends_at into new_id, new_start, new_end
    from public.book_appointment(b.service_id, p_new_starts_at, b.customer_note) as r;

    update public.bookings bk set rescheduled_from = p_booking_id where bk.id = new_id;
    insert into public.booking_events (booking_id, action, actor_id, by_customer, reason_code, details)
    values (new_id, 'rescheduled', uid, true, 'reschedule', p_booking_id::text);
    update public.staff_notifications n
    set data = n.data || jsonb_build_object('new_starts_at', new_start)
    where n.kind = 'reschedule' and n.booking_id = p_booking_id;

    return query select new_id, new_start, new_end, 'confirmed'::text;
end;
$$;

-- ---------------------------------------------------------------------------
-- Server only (notify-staff Edge Function, service_role): claim a notification before sending it.
-- Only one caller gets it, so a message is never sent twice. p_retry lets staff re-send a failed one;
-- a claim older than 2 minutes (function crashed) can be taken again.
-- ---------------------------------------------------------------------------
create or replace function public.staff_notification_claim(p_id uuid, p_booking_id uuid, p_retry boolean)
returns table (id uuid, kind text, data jsonb, created_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
begin
    return query
        update public.staff_notifications n
        set telegram_status = 'sending', telegram_claimed_at = now(), telegram_attempts = n.telegram_attempts + 1
        where (n.id = p_id or (p_id is null and n.booking_id = p_booking_id))
          and n.kind in ('cancellation', 'reschedule', 'reward', 'payment_issue')
          and (
              n.telegram_status = 'pending'
              or (p_retry and n.telegram_status in ('failed', 'not_configured'))
              or (n.telegram_status = 'sending' and n.telegram_claimed_at < now() - interval '2 minutes')
          )
        returning n.id, n.kind, n.data, n.created_at;
end;
$$;

create or replace function public.staff_notification_result(p_id uuid, p_status text, p_error text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
    if p_status not in ('sent', 'failed', 'not_configured') then
        raise exception 'invalid_status';
    end if;
    update public.staff_notifications n
    set telegram_status = p_status,
        telegram_error = left(p_error, 300),
        telegram_sent_at = case when p_status = 'sent' then now() else n.telegram_sent_at end
    where n.id = p_id and n.telegram_status = 'sending';
end;
$$;

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------
alter table public.booking_events enable row level security;
select public.reset_policies('public.booking_events');
create policy "booking_events: staff read" on public.booking_events
    for select to authenticated using ((select public.is_staff()));
revoke all on public.booking_events from anon, authenticated;
grant select on public.booking_events to authenticated;

-- Customers may see the reason they gave on their own booking (bookings: read own or staff, unchanged)

revoke all on function public.log_booking_event() from public, anon, authenticated;
revoke all on function public.cancel_my_booking(uuid, text, text) from public, anon;
revoke all on function public.reschedule_my_booking(uuid, timestamptz, text) from public, anon;
grant execute on function public.cancel_my_booking(uuid, text, text) to authenticated;
grant execute on function public.reschedule_my_booking(uuid, timestamptz, text) to authenticated;
revoke all on function public.staff_notification_claim(uuid, uuid, boolean) from public, anon, authenticated;
revoke all on function public.staff_notification_result(uuid, text, text) from public, anon, authenticated;
grant execute on function public.staff_notification_claim(uuid, uuid, boolean) to service_role;
grant execute on function public.staff_notification_result(uuid, text, text) to service_role;

commit;


-- ===== 20261101100000_phase6_loyalty.sql =====
-- Phase 6 / stage C: loyalty tools for Zeyd — find a customer without the QR code, see the history of
-- visits and rewards, and get a dashboard notification when a free haircut is used.
-- The rules of 20261031110000_phase5_loyalty.sql are unchanged (staff only, one visit per day, one reward
-- per 10 visits, each reward used once). New migration: safe to run twice.
begin;

-- Staff: search by name, e-mail or the 8-character code (when the camera or the QR code is not available)
create or replace function public.loyalty_search(p_query text)
returns table (customer_id uuid, full_name text, email text, short_code text, stamps_total integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    q text := trim(coalesce(p_query, ''));
    pattern text;
begin
    if not public.is_staff() then
        raise exception 'forbidden';
    end if;
    if char_length(q) < 2 then
        raise exception 'query_too_short';
    end if;
    -- LIKE wildcards typed by the user are matched literally
    pattern := '%' || replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
    return query
        select c.customer_id, p.full_name, p.email, c.short_code, c.stamps_total
        from public.loyalty_cards c
        join public.profiles p on p.id = c.customer_id
        where p.full_name ilike pattern or p.email ilike pattern or c.short_code = upper(q)
        order by p.full_name nulls last
        limit 10;
end;
$$;

-- Staff: every visit and reward of a card, newest first, with who confirmed it
create or replace function public.loyalty_history(p_code text)
returns table (event text, happened_at timestamptz, visit_date date, cycle integer, staff_name text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    cid uuid;
begin
    if not public.is_staff() then
        raise exception 'forbidden';
    end if;
    cid := public.loyalty_resolve_code(p_code);
    return query
        select * from (
            select case when v.kind = 'reward' then 'reward_used' else 'visit' end, v.created_at, v.visit_date,
                   null::integer, sp.full_name
            from public.loyalty_visits v
            left join public.profiles sp on sp.id = v.confirmed_by
            where v.customer_id = cid
            union all
            select 'reward_earned', r.earned_at, null::date, r.cycle, null::text
            from public.loyalty_rewards r
            where r.customer_id = cid
        ) h
        order by 2 desc
        limit 100;
end;
$$;

-- A free haircut used: shown to Zeyd in the dashboard (no Telegram for this kind)
create or replace function public.notify_reward_redeemed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    if new.redeemed_at is not null and old.redeemed_at is null then
        insert into public.staff_notifications (kind, data)
        select 'reward', jsonb_build_object('customer_name', p.full_name, 'cycle', new.cycle, 'redeemed_at', new.redeemed_at)
        from public.profiles p
        where p.id = new.customer_id;
    end if;
    return new;
end;
$$;

drop trigger if exists loyalty_rewards_notify on public.loyalty_rewards;
create trigger loyalty_rewards_notify
    after update of redeemed_at on public.loyalty_rewards
    for each row execute function public.notify_reward_redeemed();

revoke all on function public.notify_reward_redeemed() from public, anon, authenticated;
revoke all on function public.loyalty_search(text) from public, anon;
revoke all on function public.loyalty_history(text) from public, anon;
grant execute on function public.loyalty_search(text) to authenticated;
grant execute on function public.loyalty_history(text) to authenticated;

commit;


-- ===== 20261101110000_phase6_schedule_customers.sql =====
-- Phase 6 / stage D: server-side validation of services and opening hours, a warning list of upcoming
-- bookings that no longer fit the schedule, and private staff notes about customers.
-- New checks are NOT VALID: they apply to every new or edited row, and never fail on rows already there.
-- New migration: safe to run twice.
begin;

-- ---------------------------------------------------------------------------
-- Services: names, descriptions, price and duration within sensible limits
-- ---------------------------------------------------------------------------
do $$
begin
    if not exists (select 1 from pg_constraint where conname = 'services_names_check') then
        alter table public.services add constraint services_names_check check (
            char_length(btrim(name_fr)) between 1 and 60 and char_length(btrim(name_ar)) between 1 and 60
        ) not valid;
    end if;
    if not exists (select 1 from pg_constraint where conname = 'services_descriptions_check') then
        alter table public.services add constraint services_descriptions_check check (
            coalesce(char_length(description_fr), 0) <= 300 and coalesce(char_length(description_ar), 0) <= 300
        ) not valid;
    end if;
    if not exists (select 1 from pg_constraint where conname = 'services_price_range_check') then
        alter table public.services add constraint services_price_range_check check (price <= 500) not valid;
    end if;
    -- The booking grid works in steps of 5 minutes; a haircut longer than 4 hours is a typo
    if not exists (select 1 from pg_constraint where conname = 'services_duration_range_check') then
        alter table public.services add constraint services_duration_range_check check (
            duration_minutes is null or (duration_minutes between 5 and 240 and duration_minutes % 5 = 0)
        ) not valid;
    end if;
    if not exists (select 1 from pg_constraint where conname = 'closures_reason_length_check') then
        alter table public.closures add constraint closures_reason_length_check
            check (reason is null or char_length(reason) <= 120) not valid;
    end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Opening hours: two periods of the same day may not overlap (e.g. 09:00–13:00 and 12:00–19:00)
-- ---------------------------------------------------------------------------
create or replace function public.check_business_hours()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    if exists (
        select 1 from public.business_hours h
        where h.weekday = new.weekday
          and h.id <> new.id
          and h.opens_at < new.closes_at
          and new.opens_at < h.closes_at
    ) then
        raise exception 'hours_overlap';
    end if;
    return new;
end;
$$;

drop trigger if exists business_hours_no_overlap on public.business_hours;
create trigger business_hours_no_overlap
    before insert or update on public.business_hours
    for each row execute function public.check_business_hours();

-- ---------------------------------------------------------------------------
-- Staff: upcoming bookings that no longer fit the opening hours or fall on a closure.
-- Changing the schedule never touches existing bookings; this list tells Zeyd which ones to handle.
-- ---------------------------------------------------------------------------
create or replace function public.bookings_outside_schedule()
returns table (id uuid, starts_at timestamptz, ends_at timestamptz, status text, customer_name text, service_name_fr text, service_name_ar text)
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
        select b.id, b.starts_at, b.ends_at, b.status, p.full_name, sv.name_fr, sv.name_ar
        from public.bookings b
        left join public.profiles p on p.id = b.customer_id
        left join public.services sv on sv.id = b.service_id
        where b.status in ('confirmed', 'requested')
          and b.starts_at > now()
          and b.ends_at is not null
          and not public.fits_opening_hours(b.starts_at, b.ends_at)
        order by b.starts_at
        limit 50;
end;
$$;

-- ---------------------------------------------------------------------------
-- Private notes about a customer, for Zeyd only (the customer never sees them)
-- ---------------------------------------------------------------------------
create table if not exists public.customer_notes (
    customer_id uuid primary key references public.profiles (id) on delete cascade,
    note text not null check (char_length(note) <= 1000),
    updated_by uuid references auth.users (id) on delete set null,
    updated_at timestamptz not null default now()
);

create or replace function public.stamp_customer_note()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    new.updated_by := auth.uid();
    new.updated_at := now();
    return new;
end;
$$;

drop trigger if exists customer_notes_stamp on public.customer_notes;
create trigger customer_notes_stamp
    before insert or update on public.customer_notes
    for each row execute function public.stamp_customer_note();

alter table public.customer_notes enable row level security;
select public.reset_policies('public.customer_notes');
create policy "customer_notes: staff read" on public.customer_notes
    for select to authenticated using ((select public.is_staff()));
create policy "customer_notes: staff insert" on public.customer_notes
    for insert to authenticated with check ((select public.is_staff()));
create policy "customer_notes: staff update" on public.customer_notes
    for update to authenticated using ((select public.is_staff())) with check ((select public.is_staff()));
create policy "customer_notes: staff delete" on public.customer_notes
    for delete to authenticated using ((select public.is_staff()));
revoke all on public.customer_notes from anon, authenticated;
grant select, delete on public.customer_notes to authenticated;
grant insert (customer_id, note), update (note) on public.customer_notes to authenticated;

revoke all on function public.check_business_hours() from public, anon, authenticated;
revoke all on function public.stamp_customer_note() from public, anon, authenticated;
revoke all on function public.bookings_outside_schedule() from public, anon;
grant execute on function public.bookings_outside_schedule() to authenticated;

commit;


-- ===== 20261101120000_phase6_allocations.sql =====
-- Phase 6 / stage E: payment records and the revenue allocation rule, in integer cents.
--   Qualifying 10 € payment → Zeyd 10 €, mother 0 €.
--   Qualifying 15 € payment → Zeyd 10 €, mother 5 €.
-- "Qualifying" = the amount is exactly the price of the booked service AND is 10 € or 15 €. Anything else is
-- recorded as "needs_review" (no split invented). An allocation is an accounting record: it does NOT move
-- money. Money arrives on the Stripe account configured (the mother's); paying Zeyd or the mother is a
-- manual step, recorded here by an admin once it has really been done.
-- New migration: safe to run twice.
begin;

-- ---------------------------------------------------------------------------
-- Payments: how it was paid and who confirmed a payment made outside Stripe
-- ---------------------------------------------------------------------------
alter table public.payments add column if not exists method text not null default 'stripe_checkout';
alter table public.payments add column if not exists reference text;
alter table public.payments add column if not exists confirmed_by uuid references auth.users (id) on delete set null;

do $$
begin
    if not exists (select 1 from pg_constraint where conname = 'payments_method_check') then
        alter table public.payments add constraint payments_method_check
            check (method in ('stripe_checkout', 'cash', 'card_terminal', 'bank_transfer'));
    end if;
    if not exists (select 1 from pg_constraint where conname = 'payments_reference_length_check') then
        alter table public.payments add constraint payments_reference_length_check
            check (reference is null or char_length(reference) <= 100);
    end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- The rule, in one place (the Edge Functions use the same numbers: supabase/functions/_shared/allocation.ts)
-- ---------------------------------------------------------------------------
create or replace function public.payment_allocation(p_amount_cents integer, p_service_price_cents integer)
returns table (qualifying boolean, zeyd_cents integer, mother_cents integer)
language sql
immutable
set search_path = ''
as $$
    select q, case when q then least(p_amount_cents, 1000) end, case when q then p_amount_cents - least(p_amount_cents, 1000) end
    from (
        select p_amount_cents in (1000, 1500) and p_amount_cents is not distinct from p_service_price_cents as q
    ) t;
$$;

-- Zeyd's share stored on the payment follows the rule (the dashboard card "Part de Zeyd").
-- Before: amount − 5 €, which gave Zeyd only 5 € on a 10 € payment.
create or replace function public.set_payment_share()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    new.barber_share_cents := least(new.amount_cents, 1000);
    return new;
end;
$$;

drop trigger if exists payments_set_share on public.payments;
create trigger payments_set_share
    before insert or update of amount_cents on public.payments
    for each row execute function public.set_payment_share();

-- ---------------------------------------------------------------------------
-- Allocation record: one per confirmed payment, never two
-- ---------------------------------------------------------------------------
create table if not exists public.payment_allocations (
    payment_id uuid primary key references public.payments (id) on delete restrict,
    amount_cents integer not null check (amount_cents > 0),
    zeyd_cents integer check (zeyd_cents >= 0),
    mother_cents integer check (mother_cents >= 0),
    rule text not null default '2026-11 10/5',
    status text not null check (status in ('recorded', 'needs_review')),
    -- What has really happened to the mother's 5 € (manual, recorded by an admin)
    mother_transfer text not null default 'not_due' check (mother_transfer in ('not_due', 'to_transfer', 'transferred')),
    transferred_at timestamptz,
    transferred_by uuid references auth.users (id) on delete set null,
    transfer_reference text check (transfer_reference is null or char_length(transfer_reference) <= 100),
    created_at timestamptz not null default now(),
    check (status <> 'recorded' or zeyd_cents + mother_cents = amount_cents)
);

create or replace function public.record_payment_allocation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    price_cents integer;
    a record;
begin
    if new.status <> 'paid' or (tg_op = 'UPDATE' and old.status = 'paid') then
        return new;
    end if;
    select round(sv.price * 100)::integer into price_cents
    from public.bookings b join public.services sv on sv.id = b.service_id
    where b.id = new.booking_id;
    select * into a from public.payment_allocation(new.amount_cents, price_cents);
    insert into public.payment_allocations (payment_id, amount_cents, zeyd_cents, mother_cents, status, mother_transfer)
    values (
        new.id, new.amount_cents, a.zeyd_cents, a.mother_cents,
        case when a.qualifying then 'recorded' else 'needs_review' end,
        case when a.qualifying and a.mother_cents > 0 then 'to_transfer' else 'not_due' end
    )
    on conflict (payment_id) do nothing; -- a replayed event or a second update never allocates twice
    return new;
end;
$$;

drop trigger if exists payments_record_allocation on public.payments;
create trigger payments_record_allocation
    after insert or update of status on public.payments
    for each row execute function public.record_payment_allocation();

-- A payment that went wrong is shown to Zeyd in the dashboard (failed, wrong amount, paid twice)
create or replace function public.notify_payment_issue()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    if new.status in ('failed', 'mismatch', 'duplicate') and old.status is distinct from new.status then
        insert into public.staff_notifications (kind, booking_id, amount_cents, livemode, data)
        values ('payment_issue', null, new.amount_cents, coalesce(new.livemode, false),
                jsonb_build_object('status', new.status, 'payment_id', new.id, 'booking_id', new.booking_id));
    end if;
    return new;
end;
$$;

drop trigger if exists payments_notify_issue on public.payments;
create trigger payments_notify_issue
    after update of status on public.payments
    for each row execute function public.notify_payment_issue();

-- Payments already paid before this migration get their allocation too (dev data; idempotent)
update public.payments set amount_cents = amount_cents where status = 'paid';
insert into public.payment_allocations (payment_id, amount_cents, zeyd_cents, mother_cents, status, mother_transfer)
select p.id, p.amount_cents, a.zeyd_cents, a.mother_cents,
       case when a.qualifying then 'recorded' else 'needs_review' end,
       case when a.qualifying and a.mother_cents > 0 then 'to_transfer' else 'not_due' end
from public.payments p
join public.bookings b on b.id = p.booking_id
join public.services sv on sv.id = b.service_id
cross join lateral public.payment_allocation(p.amount_cents, round(sv.price * 100)::integer) a
where p.status = 'paid'
on conflict (payment_id) do nothing;

-- ---------------------------------------------------------------------------
-- Staff: a payment received outside Stripe (cash, card terminal, bank transfer checked in the bank's app).
-- Never from a customer's claim or screenshot: only an authenticated staff member can record it.
-- ---------------------------------------------------------------------------
create or replace function public.staff_record_payment(
    p_booking_id uuid,
    p_amount_cents integer,
    p_method text,
    p_reference text default null
)
returns table (payment_id uuid, allocation_status text, zeyd_cents integer, mother_cents integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
    b public.bookings;
    ref text := nullif(trim(p_reference), '');
    new_id uuid;
begin
    if not public.is_staff() then
        raise exception 'forbidden';
    end if;
    if p_method not in ('cash', 'card_terminal', 'bank_transfer') then
        raise exception 'invalid_method';
    end if;
    if p_method = 'bank_transfer' and ref is null then
        raise exception 'reference_required'; -- the transfer must be found in the bank's own app first
    end if;
    if p_amount_cents is null or p_amount_cents <= 0 or p_amount_cents > 50000 then
        raise exception 'invalid_amount';
    end if;
    select * into b from public.bookings bk where bk.id = p_booking_id for update;
    if not found then
        raise exception 'not_found';
    end if;
    if b.status not in ('confirmed', 'completed') then
        raise exception 'invalid_status';
    end if;
    begin
        insert into public.payments (booking_id, customer_id, amount_cents, currency, barber_share_cents, status, paid_at,
                                     livemode, method, reference, confirmed_by)
        values (p_booking_id, b.customer_id, p_amount_cents, 'eur', 0, 'paid', now(), true, p_method, ref, auth.uid())
        returning id into new_id;
    exception
        when unique_violation then
            raise exception 'already_paid';
    end;
    insert into public.staff_notifications (kind, payment_id, amount_cents, livemode)
    values ('payment', new_id, least(p_amount_cents, 1000), true)
    on conflict on constraint staff_notifications_payment_id_key do nothing;
    return query
        select new_id, pa.status, pa.zeyd_cents, pa.mother_cents
        from public.payment_allocations pa where pa.payment_id = new_id;
end;
$$;

-- Admin: the mother's share has really been transferred (recorded once, with the bank reference)
create or replace function public.staff_mark_mother_transfer(p_payment_id uuid, p_reference text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
    if not public.is_admin() then
        raise exception 'forbidden';
    end if;
    update public.payment_allocations pa
    set mother_transfer = 'transferred', transferred_at = now(), transferred_by = auth.uid(),
        transfer_reference = nullif(trim(p_reference), '')
    where pa.payment_id = p_payment_id and pa.mother_transfer = 'to_transfer';
    if not found then
        raise exception 'nothing_to_transfer';
    end if;
end;
$$;

-- Staff: payment list with booking, method, reference and allocation (dashboard "Paiements")
create or replace function public.payment_records(p_limit integer default 100)
returns table (
    payment_id uuid, created_at timestamptz, paid_at timestamptz, amount_cents integer, currency text, status text,
    method text, reference text, livemode boolean, booking_starts_at timestamptz, customer_name text,
    service_name_fr text, service_name_ar text, allocation_status text, zeyd_cents integer, mother_cents integer,
    mother_transfer text, transferred_at timestamptz
)
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
        select p.id, p.created_at, p.paid_at, p.amount_cents, p.currency, p.status, p.method,
               coalesce(p.reference, p.stripe_payment_intent_id), p.livemode, b.starts_at, pr.full_name,
               sv.name_fr, sv.name_ar, pa.status, pa.zeyd_cents, pa.mother_cents, pa.mother_transfer, pa.transferred_at
        from public.payments p
        left join public.bookings b on b.id = p.booking_id
        left join public.profiles pr on pr.id = p.customer_id
        left join public.services sv on sv.id = b.service_id
        left join public.payment_allocations pa on pa.payment_id = p.id
        where p.status <> 'pending'
        order by p.created_at desc
        limit least(greatest(p_limit, 1), 500);
end;
$$;

-- Staff: totals by mode (test / real), in cents
create or replace function public.allocation_summary()
returns table (livemode boolean, payments_count integer, amount_cents bigint, zeyd_cents bigint, mother_cents bigint,
               mother_to_transfer_cents bigint, needs_review_count integer)
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
        select coalesce(p.livemode, false), count(*)::integer, sum(pa.amount_cents),
               coalesce(sum(pa.zeyd_cents), 0), coalesce(sum(pa.mother_cents), 0),
               coalesce(sum(pa.mother_cents) filter (where pa.mother_transfer = 'to_transfer'), 0),
               (count(*) filter (where pa.status = 'needs_review'))::integer
        from public.payment_allocations pa
        join public.payments p on p.id = pa.payment_id
        group by coalesce(p.livemode, false);
end;
$$;

-- ---------------------------------------------------------------------------
-- Access: staff read the allocations; nobody writes them directly (only the triggers and functions above)
-- ---------------------------------------------------------------------------
alter table public.payment_allocations enable row level security;
select public.reset_policies('public.payment_allocations');
create policy "payment_allocations: staff read" on public.payment_allocations
    for select to authenticated using ((select public.is_staff()));
revoke all on public.payment_allocations from anon, authenticated;
grant select on public.payment_allocations to authenticated;

revoke all on function public.set_payment_share() from public, anon, authenticated;
revoke all on function public.record_payment_allocation() from public, anon, authenticated;
revoke all on function public.notify_payment_issue() from public, anon, authenticated;
revoke all on function public.staff_record_payment(uuid, integer, text, text) from public, anon;
revoke all on function public.staff_mark_mother_transfer(uuid, text) from public, anon;
revoke all on function public.payment_records(integer) from public, anon;
revoke all on function public.allocation_summary() from public, anon;
grant execute on function public.staff_record_payment(uuid, integer, text, text) to authenticated;
grant execute on function public.staff_mark_mother_transfer(uuid, text) to authenticated;
grant execute on function public.payment_records(integer) to authenticated;
grant execute on function public.allocation_summary() to authenticated;
-- payment_allocation() is a pure calculation (no data): callable by the server and tests
revoke all on function public.payment_allocation(integer, integer) from public, anon, authenticated;
grant execute on function public.payment_allocation(integer, integer) to service_role;

commit;


-- ===== 20261102090000_cancel_other_details_optional.sql =====
-- Customer cancellation: the details are optional for every reason, « Autre raison / سبب آخر » included.
-- Only change to cancel_my_booking (20261101090000_phase6_cancellations.sql): the « details_required » check is
-- removed. Everything else is identical: reason from the list, 500 characters at most, own booking only,
-- confirmed or requested only, cancellation notice. No table, column, policy or data change.
-- New migration: safe to run twice.
begin;

create or replace function public.cancel_my_booking(p_booking_id uuid, p_reason_code text, p_details text default null)
returns table (id uuid, status text, cancelled_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
    s public.booking_settings;
    uid uuid := auth.uid();
    b public.bookings;
    details text := nullif(trim(p_details), '');
begin
    if uid is null then
        raise exception 'auth_required';
    end if;
    if p_reason_code is null
        or p_reason_code not in ('reschedule', 'unavailable', 'time_unsuitable', 'dissatisfied', 'price_service', 'other') then
        raise exception 'invalid_reason';
    end if;
    if char_length(details) > 500 then
        raise exception 'details_too_long';
    end if;

    select * into s from public.booking_settings bs where bs.id;
    select * into b from public.bookings bk where bk.id = p_booking_id for update;
    -- Someone else's booking looks exactly like a missing one
    if not found or b.customer_id <> uid then
        raise exception 'not_found';
    end if;
    -- Already cancelled (second click, second tab): refused, so nothing happens twice
    if b.status not in ('confirmed', 'requested') then
        raise exception 'invalid_status';
    end if;
    if b.starts_at < now() + make_interval(mins => s.cancel_notice_minutes) then
        raise exception 'too_late_to_cancel';
    end if;

    update public.bookings bk
    set status = 'cancelled', cancelled_at = now(), cancelled_by = uid,
        cancel_reason_code = p_reason_code, cancel_details = details
    where bk.id = p_booking_id;

    return query select bk.id, bk.status, bk.cancelled_at from public.bookings bk where bk.id = p_booking_id;
end;
$$;

-- Same rights as before (create or replace keeps them; restated so the file stands on its own)
revoke all on function public.cancel_my_booking(uuid, text, text) from public, anon;
grant execute on function public.cancel_my_booking(uuid, text, text) to authenticated;

commit;


-- ===== 20261102100000_loyalty_50h_cooldown.sql =====
-- Loyalty: at least 50 hours between two stamps of the same customer.
-- Only change to loyalty_confirm_visit (20261031110000_phase5_loyalty.sql): after the card is locked, the last
-- stamp of the customer is read; if it is less than 50 hours old the call is refused with « cooldown_active »
-- and the time when the next stamp becomes possible is given in the error hint (ISO 8601, UTC), shown in the
-- dashboard. The lock (select … for update on the card) already makes two scans at the same moment run one
-- after the other, so the second one sees the first stamp and is refused.
-- Unchanged: staff only, code resolution, booking check, one visit per day, reward every 10 stamps, redeeming a
-- reward (the free cut gives no stamp, so it neither waits nor starts a wait). No table, column, policy or data
-- change. New migration: safe to run twice.
begin;

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
    next_allowed timestamptz;
begin
    if not public.is_staff() then
        raise exception 'forbidden';
    end if;
    cid := public.loyalty_resolve_code(p_code);
    select (now() at time zone bs.timezone)::date into today from public.booking_settings bs where bs.id;

    -- Lock the card: two scans at the same moment are handled one after the other
    perform 1 from public.loyalty_cards c where c.customer_id = cid for update;

    -- 50 hours between two stamps, counted from the last stamp actually recorded
    select max(v.created_at) + interval '50 hours' into next_allowed
    from public.loyalty_visits v
    where v.customer_id = cid and v.kind = 'stamp';
    if next_allowed is not null and now() < next_allowed then
        raise exception 'cooldown_active'
            using hint = to_char(next_allowed at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
    end if;

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

-- Same rights as before (create or replace keeps them; restated so the file stands on its own)
revoke all on function public.loyalty_confirm_visit(text, uuid) from public, anon;
grant execute on function public.loyalty_confirm_visit(text, uuid) to authenticated;

commit;


-- ===== 20261102110000_booking_messages.sql =====
-- Internal messages between a customer and the salon, attached to one booking (no e-mail is sent).
--   * The customer writes about their own booking (ask to move it, explain a situation).
--   * Zeyd / an admin answers, or tells the customer when a booking has to be refused or moved.
--   * Each message is « new » until the other side opens the conversation (read_at); a conversation whose
--     last message comes from the other side is « answered ».
-- Nothing here changes a booking: the customer can never change its status through these functions.
-- Reused: bookings (link and owner), profiles (customer), is_staff(). Existing tables are not changed.
-- New migration: safe to run twice.
begin;

create table if not exists public.booking_messages (
    id uuid primary key default gen_random_uuid(),
    booking_id uuid not null references public.bookings (id) on delete cascade,
    customer_id uuid not null references public.profiles (id) on delete cascade,
    author_id uuid references auth.users (id) on delete set null,
    from_staff boolean not null,
    body text not null check (char_length(body) between 1 and 1000),
    created_at timestamptz not null default now(),
    read_at timestamptz -- opened by the recipient (the customer for a salon message, staff for a customer one)
);

create index if not exists booking_messages_customer_idx on public.booking_messages (customer_id, created_at desc);
create index if not exists booking_messages_booking_idx on public.booking_messages (booking_id, created_at);
create index if not exists booking_messages_unread_idx on public.booking_messages (from_staff, read_at)
    where read_at is null;

-- Read only: a customer sees the messages of their own bookings, staff see all. Every write goes through the
-- functions below (no insert / update / delete right on the table).
alter table public.booking_messages enable row level security;
select public.reset_policies('public.booking_messages');
create policy "booking_messages: own or staff" on public.booking_messages
    for select to authenticated
    using (customer_id = (select auth.uid()) or (select public.is_staff()));
revoke all on public.booking_messages from anon, authenticated;
grant select on public.booking_messages to authenticated;

-- Customer: a message about one of their own bookings. At most 10 per booking in 24 hours.
create or replace function public.customer_send_message(p_booking_id uuid, p_body text)
returns table (id uuid, created_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
    uid uuid := auth.uid();
    body text := nullif(trim(p_body), '');
    owner uuid;
begin
    if uid is null then
        raise exception 'auth_required';
    end if;
    if body is null then
        raise exception 'message_empty';
    end if;
    if char_length(body) > 1000 then
        raise exception 'message_too_long';
    end if;
    select b.customer_id into owner from public.bookings b where b.id = p_booking_id;
    -- Someone else's booking looks exactly like a missing one
    if owner is null or owner <> uid then
        raise exception 'not_found';
    end if;
    if (select count(*) from public.booking_messages m
        where m.booking_id = p_booking_id and not m.from_staff and m.created_at > now() - interval '24 hours') >= 10 then
        raise exception 'too_many_messages';
    end if;
    return query
        insert into public.booking_messages (booking_id, customer_id, author_id, from_staff, body)
        values (p_booking_id, uid, uid, false, body)
        returning booking_messages.id, booking_messages.created_at;
end;
$$;

-- Zeyd / admin: a message to the customer of a booking
create or replace function public.staff_send_message(p_booking_id uuid, p_body text)
returns table (id uuid, created_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
    body text := nullif(trim(p_body), '');
    owner uuid;
begin
    if not public.is_staff() then
        raise exception 'forbidden';
    end if;
    if body is null then
        raise exception 'message_empty';
    end if;
    if char_length(body) > 1000 then
        raise exception 'message_too_long';
    end if;
    select b.customer_id into owner from public.bookings b where b.id = p_booking_id;
    if owner is null then
        raise exception 'not_found';
    end if;
    return query
        insert into public.booking_messages (booking_id, customer_id, author_id, from_staff, body)
        values (p_booking_id, owner, auth.uid(), true, body)
        returning booking_messages.id, booking_messages.created_at;
end;
$$;

-- Customer opened their messages: the salon's messages to them become « read » (one booking, or all)
create or replace function public.mark_my_messages_read(p_booking_id uuid default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
    uid uuid := auth.uid();
    n integer;
begin
    if uid is null then
        raise exception 'auth_required';
    end if;
    update public.booking_messages m
    set read_at = now()
    where m.customer_id = uid and m.from_staff and m.read_at is null
      and (p_booking_id is null or m.booking_id = p_booking_id);
    get diagnostics n = row_count;
    return n;
end;
$$;

-- Staff opened a conversation: the customer's messages of that booking become « read »
create or replace function public.staff_mark_messages_read(p_booking_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
    n integer;
begin
    if not public.is_staff() then
        raise exception 'forbidden';
    end if;
    update public.booking_messages m
    set read_at = now()
    where m.booking_id = p_booking_id and not m.from_staff and m.read_at is null;
    get diagnostics n = row_count;
    return n;
end;
$$;

revoke all on function public.customer_send_message(uuid, text) from public, anon;
revoke all on function public.staff_send_message(uuid, text) from public, anon;
revoke all on function public.mark_my_messages_read(uuid) from public, anon;
revoke all on function public.staff_mark_messages_read(uuid) from public, anon;
grant execute on function public.customer_send_message(uuid, text) to authenticated;
grant execute on function public.staff_send_message(uuid, text) to authenticated;
grant execute on function public.mark_my_messages_read(uuid) to authenticated;
grant execute on function public.staff_mark_messages_read(uuid) to authenticated;

commit;

