-- URGENT FIX — public.profiles is readable by anyone with the public (publishable) key.
-- Found 2026-10-30: an anonymous GET /rest/v1/profiles returns every row, including email addresses.
--
-- Run once in Supabase Dashboard > SQL Editor (project ajvswfsslwwlpsbtoccz).
-- Safe to re-run. Does not delete any row. The current site (Phase 1) does not read profiles.
--
-- 1. (Optional) see what exists before changing it:
--    select policyname, cmd, roles, qual, with_check from pg_policies where schemaname = 'public' and tablename = 'profiles';

begin;

alter table public.profiles enable row level security;

-- 2. Remove every existing policy on profiles (they are what exposes the rows).
do $$
declare
    p record;
begin
    for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'profiles' loop
        execute format('drop policy %I on public.profiles', p.policyname);
    end loop;
end $$;

-- 3. Anonymous visitors get nothing; signed-in users only see and edit their own row.
revoke all on public.profiles from anon;

create policy "profiles: read own row" on public.profiles
    for select to authenticated
    using (id = auth.uid());

create policy "profiles: update own row" on public.profiles
    for update to authenticated
    using (id = auth.uid())
    with check (id = auth.uid());

-- 4. Users must never change their own role (customer -> admin) or email through the API.
revoke update on public.profiles from authenticated;
grant update (full_name, avatar_url) on public.profiles to authenticated;

commit;

-- 5. Check: this must now return [] when called with the publishable key and no session:
--    GET https://ajvswfsslwwlpsbtoccz.supabase.co/rest/v1/profiles?select=id
