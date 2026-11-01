// 50 hours between two loyalty stamps of the same customer (20261102100000_loyalty_50h_cooldown.sql), on PGlite
// against the real migrations. PGlite has a single connection: two truly parallel sessions cannot be run here;
// the card lock (select … for update) that serialises them is the same as before and is described in the migration.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { as, createDb, rows, signUp } from './helpers.mjs';

describe('50 hours between two stamps', () => {
    let db;
    let zeyd;
    let alice;
    let bob;
    let aliceCode;
    let bobCode;

    const confirm = (code) => as(db, zeyd, () => rows(db, 'select * from public.loyalty_confirm_visit($1)', [code]));
    const stamps = async (customer) =>
        (await rows(db, 'select stamps_total from public.loyalty_cards where customer_id = $1', [customer]))[0]
            .stamps_total;
    // Moves all the customer's visits back in time together (order and one-per-day kept) so that the last
    // stamp was given `ago` before now, 3 salon days earlier
    const lastStampAgo = (customer, ago) =>
        db.query(
            `update public.loyalty_visits
             set created_at = created_at + ((now() - $2::interval) - (
                     select max(v.created_at) from public.loyalty_visits v where v.customer_id = $1 and v.kind = 'stamp')),
                 visit_date = visit_date - 3
             where customer_id = $1`,
            [customer, ago],
        );

    before(async () => {
        db = await createDb();
        zeyd = await signUp(db, 'zeyd@example.test', { full_name: 'Zeyd' });
        alice = await signUp(db, 'alice@example.test', { full_name: 'Alice' });
        bob = await signUp(db, 'bob@example.test', { full_name: 'Bob' });
        await db.query("update public.profiles set role = 'barber' where id = $1", [zeyd]);
        const code = async (id) =>
            (await rows(db, 'select short_code from public.loyalty_cards where customer_id = $1', [id]))[0].short_code;
        [aliceCode, bobCode] = [await code(alice), await code(bob)];
    });

    after(() => db.close());

    test('the first stamp is given at once', async () => {
        const [first] = await confirm(aliceCode);
        assert.equal(first.stamps_total, 1);
    });

    test('repeated scans right after give nothing more', async () => {
        for (let i = 0; i < 5; i += 1) await assert.rejects(confirm(aliceCode), /cooldown_active/);
        assert.equal(await stamps(alice), 1);
    });

    test('49 h 59 min later: still refused, and the error says when the next stamp is possible', async () => {
        await lastStampAgo(alice, '49 hours 59 minutes');
        const [{ expected }] = await rows(
            db,
            `select to_char((created_at + interval '50 hours') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as expected
             from public.loyalty_visits where customer_id = $1 and kind = 'stamp'`,
            [alice],
        );
        await assert.rejects(confirm(aliceCode), (error) => {
            assert.match(error.message, /cooldown_active/);
            assert.equal(error.hint, expected);
            return true;
        });
        assert.equal(await stamps(alice), 1);
    });

    test('exactly 50 hours later: the next stamp is given', async () => {
        await lastStampAgo(alice, '50 hours');
        const [second] = await confirm(aliceCode);
        assert.equal(second.stamps_total, 2);
    });

    test('the wait is per customer: Bob is not blocked by Alice', async () => {
        const [b] = await confirm(bobCode);
        assert.equal(b.stamps_total, 1);
    });

    test('two calls in the same transaction: the second is refused, nothing is added twice', async () => {
        await lastStampAgo(alice, '51 hours');
        await db.query('begin');
        try {
            await as(db, zeyd, async () => {
                await db.query('select * from public.loyalty_confirm_visit($1)', [aliceCode]);
                // A savepoint keeps the transaction usable after the expected refusal
                await db.query('savepoint second_call');
                await assert.rejects(
                    db.query('select * from public.loyalty_confirm_visit($1)', [aliceCode]),
                    /cooldown_active/,
                );
                await db.query('rollback to savepoint second_call');
            });
        } finally {
            await db.query('rollback');
        }
        assert.equal(await stamps(alice), 2, 'the rolled-back transaction left nothing');
    });

    test('using the free cut is not blocked by the wait and does not start one', async () => {
        // Alice reaches 10 stamps, each one 3 days apart
        for (let n = (await stamps(alice)) + 1; n <= 10; n += 1) {
            await lastStampAgo(alice, '3 days');
            await confirm(aliceCode);
        }
        assert.equal(await stamps(alice), 10);
        // Next salon day, only 24 hours after the 10th stamp: the reward can be used
        await db.query(
            "update public.loyalty_visits set visit_date = visit_date - 1, created_at = created_at - interval '24 hours' where customer_id = $1",
            [alice],
        );
        const [used] = await as(db, zeyd, () =>
            rows(db, 'select * from public.loyalty_redeem_reward($1)', [aliceCode]),
        );
        assert.equal(used.available_rewards, 0);
        // The next stamp waits 50 hours from the 10th stamp, not from the free cut
        await assert.rejects(confirm(aliceCode), /cooldown_active/);
        await lastStampAgo(alice, '50 hours');
        const [eleventh] = await confirm(aliceCode);
        assert.equal(eleventh.stamps_total, 11);
    });

    test('customers still cannot give themselves a stamp', async () => {
        await as(db, alice, async () => {
            await assert.rejects(db.query('select * from public.loyalty_confirm_visit($1)', [aliceCode]), /forbidden/);
        });
    });
});
