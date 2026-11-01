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
