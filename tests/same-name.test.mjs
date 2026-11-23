// Two different people can have exactly the same name: accounts are told apart by their e-mail / id, never by
// the name, and a new account is always a plain customer (never owner or admin).
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { as, createDb, rows, signUp } from './helpers.mjs';

describe('same first and last name', () => {
    let db;
    let owner;
    let customer;

    before(async () => {
        db = await createDb();
        owner = await signUp(db, 'owner@example.test', { full_name: 'Hashem Dada' });
        await db.query("update public.profiles set role = 'admin' where id = $1", [owner]);
        customer = await signUp(db, 'customer@example.test', { full_name: 'Hashem Dada' });
    });

    after(() => db.close());

    test('both accounts exist, each with its own profile and loyalty card', async () => {
        const list = await rows(
            db,
            "select id, email, role from public.profiles where full_name = 'Hashem Dada' order by email",
        );
        assert.deepEqual(
            list.map((p) => [p.email, p.role]),
            [
                ['customer@example.test', 'customer'],
                ['owner@example.test', 'admin'],
            ],
        );
        const [{ n }] = await rows(db, 'select count(*)::int n from public.loyalty_cards where customer_id = any($1)', [
            [owner, customer],
        ]);
        assert.equal(n, 2);
    });

    test('the namesake customer gets no staff rights and cannot take them', async () => {
        await as(db, customer, async () => {
            assert.equal((await rows(db, 'select public.is_staff() s'))[0].s, false);
            assert.equal((await rows(db, 'select public.is_admin() a'))[0].a, false);
            await assert.rejects(db.query("update public.profiles set role = 'admin' where id = $1", [customer]));
            await assert.rejects(db.query("select public.set_user_role($1, 'admin')", [customer]));
        });
        const [{ role }] = await rows(db, 'select role from public.profiles where id = $1', [customer]);
        assert.equal(role, 'customer');
    });

    test('the owner keeps the admin role', async () => {
        await as(db, owner, async () => {
            assert.equal((await rows(db, 'select public.is_admin() a'))[0].a, true);
        });
    });
});
