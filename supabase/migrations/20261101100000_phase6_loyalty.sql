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
