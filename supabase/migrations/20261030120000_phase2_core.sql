-- ZEYD BARBER — Phase 2 core schema
-- Profiles & roles, services, haircut gallery & likes, all protected by Row Level Security.
--
-- Safe on a fresh Supabase project AND on the existing prototype tables (same names, columns added only).
-- It never drops a table, a column or a row. Re-running it is harmless.
-- Bookings, opening hours and loyalty are designed in docs/DATABASE.md and arrive in Phases 3 and 5:
-- this file does not touch public.bookings or public.loyalty_cards.
--
-- Roles: customer (default) < barber < admin. Promote someone only from the SQL editor:
--   update public.profiles set role = 'admin' where email = '<their email>';

begin;

-- ---------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    new.updated_at := now();
    return new;
end;
$$;

-- Drops every policy on a table so this migration always ends in a known state
-- (the prototype had permissive policies, e.g. profiles readable by anyone).
create or replace function public.reset_policies(target regclass)
returns void
language plpgsql
set search_path = ''
as $$
declare
    p record;
begin
    for p in
        select pol.polname
        from pg_catalog.pg_policy pol
        where pol.polrelid = target
    loop
        execute format('drop policy %I on %s', p.polname, target);
    end loop;
end;
$$;

revoke all on function public.reset_policies(regclass) from public;

-- ---------------------------------------------------------------------------
-- Profiles (one per auth user)
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
    id uuid primary key references auth.users (id) on delete cascade,
    full_name text,
    email text,
    role text not null default 'customer',
    avatar_url text,
    created_at timestamptz not null default now()
);

alter table public.profiles add column if not exists preferred_lang text not null default 'fr';
alter table public.profiles add column if not exists updated_at timestamptz not null default now();

do $$
begin
    if not exists (select 1 from pg_constraint where conname = 'profiles_role_check') then
        alter table public.profiles
            add constraint profiles_role_check check (role in ('customer', 'barber', 'admin'));
    end if;
    if not exists (select 1 from pg_constraint where conname = 'profiles_preferred_lang_check') then
        alter table public.profiles
            add constraint profiles_preferred_lang_check check (preferred_lang in ('fr', 'ar'));
    end if;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
    before update on public.profiles
    for each row execute function public.set_updated_at();

-- Role checks used by policies. SECURITY DEFINER so they can read profiles without recursing into RLS.
create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select exists (
        select 1 from public.profiles
        where id = (select auth.uid()) and role in ('barber', 'admin')
    );
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select exists (
        select 1 from public.profiles
        where id = (select auth.uid()) and role = 'admin'
    );
$$;

-- Create the profile automatically at sign-up. Role is always 'customer' here,
-- whatever the client puts in the sign-up metadata.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    insert into public.profiles (id, email, full_name, preferred_lang)
    values (
        new.id,
        new.email,
        nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
        case when new.raw_user_meta_data ->> 'preferred_lang' = 'ar' then 'ar' else 'fr' end
    )
    on conflict (id) do nothing;
    return new;
end;
$$;

revoke all on function public.handle_new_user() from public;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
    after insert on auth.users
    for each row execute function public.handle_new_user();

alter table public.profiles enable row level security;
select public.reset_policies('public.profiles');

create policy "profiles: read own row or staff" on public.profiles
    for select to authenticated
    using (id = (select auth.uid()) or (select public.is_staff()));

create policy "profiles: update own row" on public.profiles
    for update to authenticated
    using (id = (select auth.uid()))
    with check (id = (select auth.uid()));

-- Anonymous visitors: nothing. Signed-in users may only change harmless columns (never role or email).
revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
grant update (full_name, avatar_url, preferred_lang) on public.profiles to authenticated;

-- ---------------------------------------------------------------------------
-- Services (prices and durations, editable by staff in Phase 4)
-- ---------------------------------------------------------------------------
create table if not exists public.services (
    id uuid primary key default gen_random_uuid(),
    name_fr text not null,
    name_ar text not null,
    price numeric(6, 2) not null,
    duration_minutes integer,
    created_at timestamptz not null default now()
);

alter table public.services add column if not exists slug text;
alter table public.services add column if not exists description_fr text;
alter table public.services add column if not exists description_ar text;
alter table public.services add column if not exists is_active boolean not null default true;
alter table public.services add column if not exists sort_order integer not null default 0;
alter table public.services add column if not exists updated_at timestamptz not null default now();
-- null = duration not known yet (shown as "to be confirmed")
alter table public.services alter column duration_minutes drop not null;

create unique index if not exists services_slug_key on public.services (slug);

do $$
begin
    if not exists (select 1 from pg_constraint where conname = 'services_price_check') then
        alter table public.services add constraint services_price_check check (price >= 0);
    end if;
    if not exists (select 1 from pg_constraint where conname = 'services_duration_check') then
        alter table public.services
            add constraint services_duration_check check (duration_minutes is null or duration_minutes > 0);
    end if;
end;
$$;

drop trigger if exists services_set_updated_at on public.services;
create trigger services_set_updated_at
    before update on public.services
    for each row execute function public.set_updated_at();

-- Seed the 8 services from Zeyd/data.js.
-- Existing rows (matched by French name) only get slug, descriptions and order: their price and
-- duration are kept, because they belong to the salon. Missing services are inserted.
create temporary table service_seed (
    slug text,
    name_fr text,
    name_ar text,
    description_fr text,
    description_ar text,
    price numeric(6, 2),
    duration_minutes integer,
    sort_order integer
) on commit drop;

insert into service_seed values
    ('degrade-bas', 'Dégradé bas', 'تدرّج منخفض',
        'Dégradé court, près de la nuque et des tempes.', 'تدرّج قصير قرب الرقبة والصدغين.', 15, 35, 10),
    ('degrade-moyen', 'Dégradé moyen', 'تدرّج متوسط',
        'Dégradé qui remonte jusqu’à mi-hauteur des côtés.', 'تدرّج يرتفع حتى منتصف الجانبين.', 15, 35, 20),
    ('degrade-haut', 'Dégradé haut', 'تدرّج عالٍ',
        'Dégradé marqué, remonté haut sur les côtés.', 'تدرّج واضح يرتفع عالياً على الجانبين.', 15, 35, 30),
    ('degrade-progressif', 'Dégradé progressif', 'تدرّج تدريجي',
        'Transition douce et graduelle sur les côtés.', 'انتقال ناعم ومتدرّج على الجانبين.', 15, 35, 40),
    ('coupe-classique', 'Coupe classique', 'قصّة كلاسيكية',
        'Coupe traditionnelle, nette et facile à coiffer.', 'قصّة تقليدية مرتّبة وسهلة التصفيف.', 15, 35, 50),
    ('coupe-ciseaux', 'Coupe aux ciseaux', 'قصّة بالمقص',
        'Coupe réalisée entièrement aux ciseaux.', 'قصّة منفّذة بالكامل بالمقص.', 15, 35, 60),
    ('coupe-enfant', 'Coupe enfant', 'قصّة للأطفال',
        'Coupe de cheveux pour les enfants.', 'قصّة شعر مخصّصة للأطفال.', 10, null, 70),
    ('coupe-et-barbe', 'Coupe et barbe', 'قصّة ولحية',
        'Coupe de cheveux et taille de la barbe.', 'قصّة شعر مع تهذيب اللحية.', 15, null, 80);

update public.services s
set slug = seed.slug,
    description_fr = coalesce(s.description_fr, seed.description_fr),
    description_ar = coalesce(s.description_ar, seed.description_ar),
    sort_order = seed.sort_order
from service_seed seed
where s.slug is null
  and lower(s.name_fr) = lower(seed.name_fr)
  and not exists (select 1 from public.services other where other.slug = seed.slug);

insert into public.services
    (slug, name_fr, name_ar, description_fr, description_ar, price, duration_minutes, sort_order)
select seed.slug, seed.name_fr, seed.name_ar, seed.description_fr, seed.description_ar,
       seed.price, seed.duration_minutes, seed.sort_order
from service_seed seed
where not exists (select 1 from public.services s where s.slug = seed.slug);

alter table public.services enable row level security;
select public.reset_policies('public.services');

create policy "services: public read of active services" on public.services
    for select to anon, authenticated
    using (is_active or (select public.is_staff()));

create policy "services: staff insert" on public.services
    for insert to authenticated
    with check ((select public.is_staff()));

create policy "services: staff update" on public.services
    for update to authenticated
    using ((select public.is_staff()))
    with check ((select public.is_staff()));

create policy "services: staff delete" on public.services
    for delete to authenticated
    using ((select public.is_staff()));

revoke all on public.services from anon, authenticated;
grant select on public.services to anon, authenticated;
grant insert, update, delete on public.services to authenticated;

-- ---------------------------------------------------------------------------
-- Haircut gallery (real photos only; managed by staff in Phase 4)
-- ---------------------------------------------------------------------------
create table if not exists public.haircuts (
    id uuid primary key default gen_random_uuid(),
    title_fr text,
    title_ar text,
    desc_fr text,
    desc_ar text,
    image_url text not null,
    created_at timestamptz not null default now()
);

alter table public.haircuts add column if not exists category text;
alter table public.haircuts add column if not exists is_published boolean not null default false;
alter table public.haircuts add column if not exists sort_order integer not null default 0;
alter table public.haircuts add column if not exists updated_at timestamptz not null default now();

drop trigger if exists haircuts_set_updated_at on public.haircuts;
create trigger haircuts_set_updated_at
    before update on public.haircuts
    for each row execute function public.set_updated_at();

alter table public.haircuts enable row level security;
select public.reset_policies('public.haircuts');

create policy "haircuts: public read of published photos" on public.haircuts
    for select to anon, authenticated
    using (is_published or (select public.is_staff()));

create policy "haircuts: staff insert" on public.haircuts
    for insert to authenticated
    with check ((select public.is_staff()));

create policy "haircuts: staff update" on public.haircuts
    for update to authenticated
    using ((select public.is_staff()))
    with check ((select public.is_staff()));

create policy "haircuts: staff delete" on public.haircuts
    for delete to authenticated
    using ((select public.is_staff()));

revoke all on public.haircuts from anon, authenticated;
grant select on public.haircuts to anon, authenticated;
grant insert, update, delete on public.haircuts to authenticated;

-- ---------------------------------------------------------------------------
-- Likes: one per user and photo, only by signed-in users, only on published photos
-- ---------------------------------------------------------------------------
create table if not exists public.haircut_likes (
    id uuid primary key default gen_random_uuid(),
    haircut_id uuid not null references public.haircuts (id) on delete cascade,
    user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
    created_at timestamptz not null default now()
);

create unique index if not exists haircut_likes_one_per_user on public.haircut_likes (haircut_id, user_id);

alter table public.haircut_likes enable row level security;
select public.reset_policies('public.haircut_likes');

create policy "likes: read own likes" on public.haircut_likes
    for select to authenticated
    using (user_id = (select auth.uid()));

create policy "likes: add own like on a published photo" on public.haircut_likes
    for insert to authenticated
    with check (
        user_id = (select auth.uid())
        and exists (select 1 from public.haircuts h where h.id = haircut_id and h.is_published)
    );

create policy "likes: remove own like" on public.haircut_likes
    for delete to authenticated
    using (user_id = (select auth.uid()));

revoke all on public.haircut_likes from anon, authenticated;
grant select, delete on public.haircut_likes to authenticated;
grant insert (haircut_id) on public.haircut_likes to authenticated;

-- Public gallery with like counts, without exposing who liked what.
create or replace function public.gallery_with_likes()
returns table (
    id uuid,
    title_fr text,
    title_ar text,
    desc_fr text,
    desc_ar text,
    image_url text,
    category text,
    sort_order integer,
    like_count bigint,
    liked_by_me boolean
)
language sql
stable
security definer
set search_path = ''
as $$
    select h.id, h.title_fr, h.title_ar, h.desc_fr, h.desc_ar, h.image_url, h.category, h.sort_order,
           count(l.id) as like_count,
           coalesce(bool_or(l.user_id = (select auth.uid())), false) as liked_by_me
    from public.haircuts h
    left join public.haircut_likes l on l.haircut_id = h.id
    where h.is_published
    group by h.id
    order by h.sort_order, h.created_at desc;
$$;

revoke all on function public.gallery_with_likes() from public;
grant execute on function public.gallery_with_likes() to anon, authenticated;

commit;
