// Offline tests for the Supabase migrations, run on PGlite (Postgres compiled to WebAssembly).
// A small stub reproduces what Supabase provides: the auth schema, auth.uid(), the anon/authenticated
// roles and their default grants. Run with: npm test
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'supabase', 'migrations');
const migrations = readdirSync(MIGRATIONS_DIR)
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
const PROTOTYPE_SCHEMA = `
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

async function createDb({ prototype = false } = {}) {
    const db = new PGlite();
    await db.exec(SUPABASE_STUB);
    if (prototype) await db.exec(PROTOTYPE_SCHEMA);
    for (const sql of migrations) await db.exec(sql);
    return db;
}

// Run `fn` with the privileges PostgREST would use for this request.
async function as(db, who, fn) {
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

async function signUp(db, email, meta = {}) {
    const { rows } = await db.query('insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id', [
        email,
        JSON.stringify(meta),
    ]);
    return rows[0].id;
}

const rows = async (db, sql, params) => (await db.query(sql, params)).rows;

describe('fresh project', () => {
    let db;
    let alice;
    let bob;
    let admin;
    let published;
    let draft;

    before(async () => {
        db = await createDb();
        alice = await signUp(db, 'alice@example.test', { full_name: 'Alice', role: 'admin', preferred_lang: 'ar' });
        bob = await signUp(db, 'bob@example.test');
        admin = await signUp(db, 'admin@example.test');
        await db.query("update public.profiles set role = 'admin' where id = $1", [admin]);
        published = (
            await rows(
                db,
                "insert into public.haircuts (image_url, is_published) values ('gallery/a.jpg', true) returning id",
            )
        )[0].id;
        draft = (await rows(db, "insert into public.haircuts (image_url) values ('gallery/b.jpg') returning id"))[0].id;
    });

    after(() => db.close());

    test('migration can be re-run without errors or duplicates', async () => {
        for (const sql of migrations) await db.exec(sql);
        assert.equal((await rows(db, 'select count(*)::int as n from public.services'))[0].n, 8);
    });

    test('seeds the 8 services with prices and unknown durations as null', async () => {
        const services = await rows(
            db,
            'select slug, price::float, duration_minutes from public.services order by sort_order',
        );
        assert.equal(services.length, 8);
        assert.deepEqual(
            services.map((s) => s.price),
            [15, 15, 15, 15, 15, 15, 10, 15],
        );
        const enfant = services.find((s) => s.slug === 'coupe-enfant');
        assert.equal(enfant.duration_minutes, null);
    });

    test('sign-up creates a customer profile, ignoring a role sent by the client', async () => {
        const [profile] = await rows(db, 'select role, full_name, preferred_lang from public.profiles where id = $1', [
            alice,
        ]);
        assert.deepEqual(profile, { role: 'customer', full_name: 'Alice', preferred_lang: 'ar' });
    });

    test('anonymous visitors see active services and published photos only', async () => {
        await as(db, 'anon', async () => {
            assert.equal((await rows(db, 'select * from public.services')).length, 8);
            const gallery = await rows(db, 'select * from public.gallery_with_likes()');
            assert.deepEqual(
                gallery.map((g) => g.id),
                [published],
            );
            assert.equal((await rows(db, 'select * from public.haircuts')).length, 1);
        });
    });

    test('anonymous visitors cannot read profiles or likes', async () => {
        await as(db, 'anon', async () => {
            await assert.rejects(db.query('select * from public.profiles'), /permission denied/);
            await assert.rejects(db.query('select * from public.haircut_likes'), /permission denied/);
        });
    });

    test('anonymous visitors cannot change services or like', async () => {
        await as(db, 'anon', async () => {
            await assert.rejects(db.query('update public.services set price = 1'), /permission denied/);
            await assert.rejects(
                db.query('insert into public.haircut_likes (haircut_id) values ($1)', [published]),
                /permission denied/,
            );
        });
    });

    test('internal helper functions cannot be called through the API', async () => {
        for (const who of ['anon', bob]) {
            await as(db, who, async () => {
                await assert.rejects(
                    db.query("select public.reset_policies('public.services')"),
                    /permission denied for function/,
                );
                await assert.rejects(db.query('select public.set_updated_at()'), /permission denied for function/);
            });
        }
        // Public functions stay callable
        await as(db, 'anon', async () => {
            await db.query('select * from public.gallery_with_likes()');
        });
    });

    test('a customer only sees their own profile', async () => {
        await as(db, bob, async () => {
            const visible = await rows(db, 'select id from public.profiles');
            assert.deepEqual(
                visible.map((p) => p.id),
                [bob],
            );
        });
    });

    test('a customer can edit their name but never their role or email', async () => {
        await as(db, bob, async () => {
            await db.query("update public.profiles set full_name = 'Bob' where id = $1", [bob]);
            await assert.rejects(
                db.query("update public.profiles set role = 'admin' where id = $1", [bob]),
                /permission denied/,
            );
            await assert.rejects(
                db.query("update public.profiles set email = 'x@example.test' where id = $1", [bob]),
                /permission denied/,
            );
            // Another user's row is invisible, so the update silently changes nothing
            await db.query("update public.profiles set full_name = 'hacked' where id = $1", [alice]);
        });
        const [a] = await rows(db, 'select full_name from public.profiles where id = $1', [alice]);
        assert.equal(a.full_name, 'Alice');
        const [b] = await rows(db, 'select role, full_name from public.profiles where id = $1', [bob]);
        assert.deepEqual(b, { role: 'customer', full_name: 'Bob' });
    });

    test('a customer cannot change services', async () => {
        await as(db, bob, async () => {
            await assert.rejects(
                db.query("insert into public.services (name_fr, name_ar, price) values ('x', 'x', 1)"),
                /row-level security/,
            );
            const { affectedRows } = await db.query('update public.services set price = 1');
            assert.equal(affectedRows, 0);
        });
    });

    test('likes: one per user, published photos only, counted publicly', async () => {
        await as(db, bob, async () => {
            await db.query('insert into public.haircut_likes (haircut_id) values ($1)', [published]);
            await assert.rejects(
                db.query('insert into public.haircut_likes (haircut_id) values ($1)', [published]),
                /duplicate key/,
            );
            await assert.rejects(
                db.query('insert into public.haircut_likes (haircut_id) values ($1)', [draft]),
                /row-level security/,
            );
            // Cannot like on behalf of someone else
            await assert.rejects(
                db.query('insert into public.haircut_likes (haircut_id, user_id) values ($1, $2)', [published, alice]),
                /permission denied/,
            );
            const [mine] = await rows(db, 'select like_count::int, liked_by_me from public.gallery_with_likes()');
            assert.deepEqual(mine, { like_count: 1, liked_by_me: true });
        });
        await as(db, alice, async () => {
            await db.query('insert into public.haircut_likes (haircut_id) values ($1)', [published]);
            assert.equal(
                (await rows(db, 'select * from public.haircut_likes')).length,
                1,
                'only own likes are visible',
            );
            // Alice cannot remove Bob's like
            await db.query('delete from public.haircut_likes where user_id = $1', [bob]);
            const [g] = await rows(db, 'select like_count::int, liked_by_me from public.gallery_with_likes()');
            assert.deepEqual(g, { like_count: 2, liked_by_me: true });
        });
        await as(db, 'anon', async () => {
            const [g] = await rows(db, 'select like_count::int, liked_by_me from public.gallery_with_likes()');
            assert.deepEqual(g, { like_count: 2, liked_by_me: false });
        });
        await as(db, bob, async () => {
            await db.query('delete from public.haircut_likes where haircut_id = $1', [published]);
            const [g] = await rows(db, 'select like_count::int, liked_by_me from public.gallery_with_likes()');
            assert.deepEqual(g, { like_count: 1, liked_by_me: false });
        });
    });

    test('an admin manages services and sees every profile and draft photos', async () => {
        await as(db, admin, async () => {
            await db.query("update public.services set is_active = false where slug = 'coupe-enfant'");
            assert.equal((await rows(db, 'select * from public.services')).length, 8, 'staff still see inactive');
            assert.equal((await rows(db, 'select * from public.profiles')).length, 3);
            assert.equal((await rows(db, 'select * from public.haircuts')).length, 2);
        });
        await as(db, 'anon', async () => {
            assert.equal((await rows(db, 'select * from public.services')).length, 7, 'inactive hidden from public');
        });
    });
});

describe('existing prototype project', () => {
    let db;

    before(async () => {
        db = await createDb({ prototype: true });
    });

    after(() => db.close());

    test('keeps the existing 8 services (no duplicates) and their prices and durations', async () => {
        const services = await rows(
            db,
            'select slug, name_fr, price::float, duration_minutes from public.services order by sort_order',
        );
        assert.equal(services.length, 8);
        assert.ok(services.every((s) => s.slug));
        assert.equal(services.find((s) => s.slug === 'coupe-et-barbe').duration_minutes, 45);
    });

    test('replaces the public profiles policy: anonymous visitors no longer read profiles', async () => {
        await signUp(db, 'someone@example.test');
        await as(db, 'anon', async () => {
            await assert.rejects(db.query('select * from public.profiles'), /permission denied/);
        });
        const policies = await rows(db, "select polname from pg_policy where polrelid = 'public.profiles'::regclass");
        assert.ok(!policies.some((p) => p.polname === 'Public profiles are viewable by everyone'));
    });

    test('removes the permissive services policy', async () => {
        const someone = await signUp(db, 'other@example.test');
        await as(db, someone, async () => {
            const { affectedRows } = await db.query('update public.services set price = 1');
            assert.equal(affectedRows, 0);
        });
    });
});
