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
