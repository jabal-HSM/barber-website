// Phase 6 stage C: loyalty search, history and reward notification; plus the security rules of the QR flow
// re-checked end to end (admin only, no replay, one reward use). Run with: npm test
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { as, createDb, rows, signUp } from './helpers.mjs';

const shiftVisitsBack = (db, customer) =>
    db.query('update public.loyalty_visits set visit_date = visit_date - 1 where customer_id = $1', [customer]);

describe('loyalty tools for Zeyd', () => {
    let db;
    let zeyd;
    let alice;
    let bob;
    let qr;
    let code;

    before(async () => {
        db = await createDb();
        zeyd = await signUp(db, 'zeyd@example.test', { full_name: 'Zeyd' });
        alice = await signUp(db, 'alice.martin@example.test', { full_name: 'Alice Martin' });
        bob = await signUp(db, 'bob@example.test', { full_name: 'Bob 100%_Durand' });
        await db.query("update public.profiles set role = 'barber' where id = $1", [zeyd]);
        const [card] = await rows(db, 'select token, short_code from public.loyalty_cards where customer_id = $1', [
            alice,
        ]);
        qr = `ZEYD-LOYALTY:${card.token}`;
        code = card.short_code;
    });

    after(() => db.close());

    test('only staff can search; customers and visitors get nothing', async () => {
        await as(db, alice, async () => {
            await assert.rejects(db.query("select * from public.loyalty_search('Mar')"), /forbidden/);
        });
        await as(db, 'anon', async () => {
            await assert.rejects(db.query("select * from public.loyalty_search('Mar')"), /permission denied/);
        });
    });

    test('search by part of the name, the e-mail or the code; wildcards are taken literally', async () => {
        await as(db, zeyd, async () => {
            await assert.rejects(db.query("select * from public.loyalty_search('a')"), /query_too_short/);
            assert.deepEqual(
                (await rows(db, "select full_name from public.loyalty_search('martin')")).map((r) => r.full_name),
                ['Alice Martin'],
            );
            assert.equal((await rows(db, "select 1 from public.loyalty_search('alice.mar')")).length, 1);
            assert.equal((await rows(db, 'select 1 from public.loyalty_search($1)', [code.toLowerCase()])).length, 1);
            assert.equal(
                (await rows(db, "select 1 from public.loyalty_search('%%')")).length,
                0,
                '% is not "everything"',
            );
            assert.equal((await rows(db, "select 1 from public.loyalty_search('100%_')")).length, 1);
        });
    });

    test('customers cannot confirm a visit or use a reward, even with a valid QR code', async () => {
        await as(db, alice, async () => {
            await assert.rejects(db.query('select * from public.loyalty_confirm_visit($1)', [qr]), /forbidden/);
            await assert.rejects(db.query('select * from public.loyalty_redeem_reward($1)', [qr]), /forbidden/);
            await assert.rejects(db.query('select * from public.loyalty_history($1)', [qr]), /forbidden/);
        });
        await as(db, bob, async () => {
            await assert.rejects(db.query('select * from public.loyalty_confirm_visit($1)', [qr]), /forbidden/);
        });
    });

    test('scanning the same QR code twice the same day counts one visit (no replay)', async () => {
        await as(db, zeyd, async () => {
            await db.query('select * from public.loyalty_confirm_visit($1)', [qr]);
            await assert.rejects(db.query('select * from public.loyalty_confirm_visit($1)', [qr]), /already_counted/);
            await assert.rejects(db.query('select * from public.loyalty_confirm_visit($1)', [code]), /already_counted/);
        });
        const [card] = await rows(db, 'select stamps_total from public.loyalty_cards where customer_id = $1', [alice]);
        assert.equal(card.stamps_total, 1);
    });

    test('a forged or unknown code is refused', async () => {
        await as(db, zeyd, async () => {
            await assert.rejects(
                db.query('select * from public.loyalty_confirm_visit($1)', [
                    'ZEYD-LOYALTY:00000000-0000-0000-0000-000000000000',
                ]),
                /invalid_code/,
            );
            await assert.rejects(db.query("select * from public.loyalty_confirm_visit('<script>')"), /invalid_code/);
        });
    });

    test('ten visits give one free haircut, used once; the history and the dashboard keep track', async () => {
        for (let i = 2; i <= 10; i += 1) {
            await shiftVisitsBack(db, alice);
            await as(db, zeyd, () => db.query('select * from public.loyalty_confirm_visit($1)', [qr]));
        }
        await shiftVisitsBack(db, alice);
        await as(db, zeyd, () => db.query('select * from public.loyalty_redeem_reward($1)', [qr]));
        await shiftVisitsBack(db, alice);
        await as(db, zeyd, async () => {
            await assert.rejects(db.query('select * from public.loyalty_redeem_reward($1)', [qr]), /no_reward/);
        });

        const history = await as(db, zeyd, () => rows(db, 'select * from public.loyalty_history($1)', [code]));
        assert.equal(history.filter((h) => h.event === 'visit').length, 10);
        assert.equal(history.filter((h) => h.event === 'reward_earned').length, 1);
        assert.equal(history.filter((h) => h.event === 'reward_used').length, 1);
        assert.ok(
            history.filter((h) => h.event === 'visit').every((h) => h.staff_name === 'Zeyd'),
            'who confirmed',
        );

        const notes = await rows(db, "select data from public.staff_notifications where kind = 'reward'");
        assert.equal(notes.length, 1);
        assert.equal(notes[0].data.customer_name, 'Alice Martin');
    });
});
