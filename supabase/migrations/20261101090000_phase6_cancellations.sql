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
