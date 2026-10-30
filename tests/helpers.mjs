// Shared PGlite setup for the database tests.
// A small stub reproduces what Supabase provides: the auth schema, auth.uid(), the anon/authenticated
// roles and their default grants.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'supabase', 'migrations');
export const migrations = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));

const SUPABASE_STUB = `
    create role anon nologin;
    create role authenticated nologin;
    create schema auth;
    create table auth.users (
        id uuid primary key default gen_random_uuid(),
        email text,
        raw_user_meta_data jsonb not null default '{}'
    );
    create function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    grant usage on schema auth to anon, authenticated;
    grant usage on schema public to anon, authenticated;
    -- Supabase grants everything in public by default; RLS and explicit revokes must do the protecting.
    alter default privileges in schema public grant all on tables to anon, authenticated;
    alter default privileges in schema public grant all on functions to anon, authenticated;
`;

// Tables as they exist in the production prototype, with the kind of permissive policies it had.
export const PROTOTYPE_SCHEMA = `
    create table public.profiles (
        id uuid primary key references auth.users (id) on delete cascade,
        full_name text, email text, role text default 'customer', avatar_url text,
        created_at timestamptz default now()
    );
    create table public.services (
        id uuid primary key default gen_random_uuid(),
        name_fr text not null, name_ar text not null, price numeric(10, 2) not null,
        duration_minutes integer not null, created_at timestamptz default now()
    );
    create table public.haircuts (
        id uuid primary key default gen_random_uuid(),
        title_fr text, title_ar text, desc_fr text, desc_ar text, image_url text,
        price numeric, likes_count integer default 0, created_at timestamptz default now()
    );
    create table public.haircut_likes (
        id uuid primary key default gen_random_uuid(),
        haircut_id uuid references public.haircuts (id), user_id uuid references auth.users (id),
        created_at timestamptz default now(), unique (haircut_id, user_id)
    );
    create table public.bookings (
        id uuid primary key default gen_random_uuid(),
        customer_id uuid not null references auth.users (id), service_id uuid not null references public.services (id),
        booking_date date not null, booking_time text not null, is_custom_time boolean not null default false,
        status text default 'pending', created_at timestamptz default now()
    );
    alter table public.bookings enable row level security;
    create policy "insert own" on public.bookings for insert with check (auth.uid() = customer_id);
    alter table public.profiles enable row level security;
    create policy "Public profiles are viewable by everyone" on public.profiles for select using (true);
    alter table public.services enable row level security;
    create policy "anyone" on public.services for all using (true) with check (true);
    insert into public.services (name_fr, name_ar, price, duration_minutes) values
        ('Dégradé bas', 'تدرج منخفض', 15, 35), ('Dégradé moyen', 'تدرج متوسط', 15, 35),
        ('Dégradé haut', 'تدرج عالي', 15, 35), ('Dégradé progressif', 'تدرج تدريجي', 15, 35),
        ('Coupe classique', 'قصة كلاسيكية', 15, 30), ('Coupe aux ciseaux', 'قصة بالمقص', 15, 40),
        ('Coupe enfant', 'قصة أطفال', 10, 30), ('Coupe et barbe', 'قصة ولحية', 15, 45);
`;

export async function createDb({ prototype = false } = {}) {
    const db = new PGlite();
    await db.exec(SUPABASE_STUB);
    if (prototype) await db.exec(PROTOTYPE_SCHEMA);
    for (const sql of migrations) await db.exec(sql);
    return db;
}

// Run `fn` with the privileges PostgREST would use for this request.
export async function as(db, who, fn) {
    const sub = who === 'anon' ? '' : who;
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [sub]);
    await db.exec(`set role ${who === 'anon' ? 'anon' : 'authenticated'}`);
    try {
        return await fn();
    } finally {
        await db.exec('reset role');
        await db.query("select set_config('request.jwt.claim.sub', '', false)");
    }
}

export async function signUp(db, email, meta = {}) {
    const { rows } = await db.query('insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id', [
        email,
        JSON.stringify(meta),
    ]);
    return rows[0].id;
}

export const rows = async (db, sql, params) => (await db.query(sql, params)).rows;
