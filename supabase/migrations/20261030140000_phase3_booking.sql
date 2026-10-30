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
