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
