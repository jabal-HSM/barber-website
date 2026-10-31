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
