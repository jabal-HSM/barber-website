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
