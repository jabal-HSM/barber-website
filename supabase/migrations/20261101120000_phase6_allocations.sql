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
