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
