// Phase 4 (roles, gallery storage), Phase 5 (loyalty) and payments, on PGlite. Run with: npm test
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { as, createDb, rows, signUp } from './helpers.mjs';

const TZ = 'Europe/Paris';

async function serviceId(db, slug) {
    return (await rows(db, 'select id from public.services where slug = $1', [slug]))[0].id;
}

// A confirmed booking created directly (the booking rules are tested elsewhere)
async function insertBooking(db, customer, service, daysAhead = 3, status = 'confirmed') {
    const [b] = await rows(
        db,
        `insert into public.bookings (customer_id, service_id, starts_at, ends_at, status)
         values ($1, $2, now() + $3::float * interval '1 day', now() + $3::float * interval '1 day' + interval '35 minutes', $4)
         returning id`,
        [customer, service, daysAhead, status],
    );
    return b.id;
}

// Simulates the next calendar day for the once-per-day visit rule
const shiftVisitsBack = (db, customer) =>
    db.query('update public.loyalty_visits set visit_date = visit_date - 1 where customer_id = $1', [customer]);

describe('roles and dashboard permissions', () => {
    let db;
    let admin;
    let barber;
    let customer;

    before(async () => {
        db = await createDb();
        admin = await signUp(db, 'admin@example.test');
        barber = await signUp(db, 'zeyd@example.test');
        customer = await signUp(db, 'client@example.test');
        await db.query("update public.profiles set role = 'admin' where id = $1", [admin]);
    });

    after(() => db.close());

    test('nobody becomes staff at sign-up; only an admin changes roles, never their own', async () => {
        assert.equal((await rows(db, 'select role from public.profiles where id = $1', [barber]))[0].role, 'customer');
        await as(db, customer, async () => {
            await assert.rejects(db.query("select public.set_user_role($1, 'admin')", [customer]), /forbidden/);
        });
        await as(db, admin, async () => {
            await db.query("select public.set_user_role($1, 'barber')", [barber]);
            await assert.rejects(
                db.query("select public.set_user_role($1, 'customer')", [admin]),
                /cannot_change_own_role/,
            );
            await assert.rejects(db.query("select public.set_user_role($1, 'king')", [customer]), /invalid_role/);
        });
        await as(db, barber, async () => {
            await assert.rejects(db.query("select public.set_user_role($1, 'admin')", [customer]), /forbidden/);
        });
        assert.equal((await rows(db, 'select role from public.profiles where id = $1', [barber]))[0].role, 'barber');
    });

    test('the barber manages services, hours and closures; customers cannot', async () => {
        await as(db, barber, async () => {
            await db.query("update public.services set price = 16 where slug = 'degrade-bas'");
            await db.query(
                "insert into public.closures (starts_on, ends_on, reason) values ('2030-08-01', '2030-08-15', 'Congés')",
            );
            await db.query(
                "update public.business_hours set closes_at = '18:30' where weekday = 6 and opens_at = '14:00'",
            );
        });
        assert.equal(
            (await rows(db, "select price::float from public.services where slug = 'degrade-bas'"))[0].price,
            16,
        );
        await as(db, customer, async () => {
            const { affectedRows } = await db.query('delete from public.closures');
            assert.equal(affectedRows, 0);
        });
        assert.equal((await rows(db, 'select count(*)::int as n from public.closures'))[0].n, 1);
    });

    test('booking settings: admin only (the barber can read them)', async () => {
        await as(db, barber, async () => {
            const { affectedRows } = await db.query('update public.booking_settings set max_days_ahead = 60');
            assert.equal(affectedRows, 0);
        });
        await as(db, admin, async () => {
            const { affectedRows } = await db.query('update public.booking_settings set max_days_ahead = 45');
            assert.equal(affectedRows, 1);
        });
    });

    test('gallery storage: staff upload, customers and visitors cannot', async () => {
        const [bucket] = await rows(db, "select public from storage.buckets where id = 'gallery'");
        assert.equal(bucket.public, true);
        await as(db, barber, async () => {
            await db.query("insert into storage.objects (bucket_id, name) values ('gallery', 'a.jpg')");
        });
        for (const who of [customer, 'anon']) {
            await as(db, who, async () => {
                await assert.rejects(
                    db.query("insert into storage.objects (bucket_id, name) values ('gallery', 'b.jpg')"),
                    /row-level security/,
                );
            });
        }
    });
});

describe('loyalty card', () => {
    let db;
    let barber;
    let alice;
    let bob;
    let aliceCard;
    let fade;

    before(async () => {
        db = await createDb();
        barber = await signUp(db, 'zeyd@example.test');
        alice = await signUp(db, 'alice@example.test', { full_name: 'Alice Martin' });
        bob = await signUp(db, 'bob@example.test');
        await db.query("update public.profiles set role = 'barber' where id = $1", [barber]);
        fade = await serviceId(db, 'degrade-bas');
        [aliceCard] = await as(db, alice, () => rows(db, 'select * from public.my_loyalty()'));
    });

    after(() => db.close());

    const confirm = (code, booking = null) =>
        as(db, barber, () => rows(db, 'select * from public.loyalty_confirm_visit($1, $2)', [code, booking]));

    test('every customer gets a card with a random QR token, and sees only their own', async () => {
        assert.equal(aliceCard.full_name, 'Alice Martin');
        assert.equal(aliceCard.stamps_total, 0);
        assert.match(aliceCard.short_code, /^[0-9A-F]{8}$/);
        assert.notEqual(aliceCard.token, alice, 'the QR token is not the user id');
        await as(db, bob, async () => {
            assert.equal((await rows(db, 'select * from public.loyalty_cards')).length, 1, 'only his own card');
        });
        await as(db, 'anon', async () => {
            await assert.rejects(db.query('select * from public.loyalty_cards'), /permission denied/);
        });
    });

    test('a customer cannot add stamps or rewards to their own card', async () => {
        await as(db, alice, async () => {
            await assert.rejects(db.query('update public.loyalty_cards set stamps_total = 99'), /permission denied/);
            await assert.rejects(
                db.query(
                    "insert into public.loyalty_visits (customer_id, visit_date, kind) values ($1, current_date, 'stamp')",
                    [alice],
                ),
                /permission denied/,
            );
            await assert.rejects(
                db.query('insert into public.loyalty_rewards (customer_id, cycle) values ($1, 1)', [alice]),
                /permission denied/,
            );
            // Scanning/confirming is staff-only
            await assert.rejects(
                db.query('select * from public.loyalty_confirm_visit($1)', [aliceCard.short_code]),
                /forbidden/,
            );
            await assert.rejects(
                db.query('select * from public.loyalty_lookup($1)', [aliceCard.short_code]),
                /forbidden/,
            );
        });
    });

    test('the barber looks up the QR code and confirms the visit: +1 stamp, once per day', async () => {
        const qr = `ZEYD-LOYALTY:${aliceCard.token}`;
        const [found] = await as(db, barber, () => rows(db, 'select * from public.loyalty_lookup($1)', [qr]));
        assert.equal(found.full_name, 'Alice Martin');
        assert.equal(found.visited_today, false);

        const [first] = await confirm(qr);
        assert.equal(first.stamps_total, 1);
        await assert.rejects(confirm(qr), /already_counted/, 'scanning again the same day does nothing');
        await assert.rejects(
            confirm(aliceCard.short_code.toLowerCase()),
            /already_counted/,
            'same with the short code',
        );
        await assert.rejects(confirm('ZEYD-LOYALTY:00000000-0000-0000-0000-000000000000'), /invalid_code/);
        await assert.rejects(confirm('nonsense'), /invalid_code/);
    });

    test('a visit linked to a booking: the booking can be counted only once, and only for its customer', async () => {
        await shiftVisitsBack(db, alice);
        const bobsBooking = await insertBooking(db, bob, fade);
        await assert.rejects(confirm(aliceCard.short_code, bobsBooking), /invalid_booking/);
        const booking = await insertBooking(db, alice, fade, -0.01);
        await confirm(aliceCard.short_code, booking);
        assert.equal(
            (await rows(db, 'select status from public.bookings where id = $1', [booking]))[0].status,
            'completed',
        );
        await shiftVisitsBack(db, alice);
        await assert.rejects(confirm(aliceCard.short_code, booking), /already_counted/);
    });

    test('the 10th stamp creates exactly one reward; redeeming it works once', async () => {
        let last;
        for (let i = 0; i < 8; i += 1) {
            await shiftVisitsBack(db, alice);
            [last] = await confirm(aliceCard.short_code);
        }
        assert.equal(last.stamps_total, 10);
        assert.equal(last.reward_earned, true);
        assert.equal(last.available_rewards, 1);
        assert.equal((await rows(db, 'select count(*)::int as n from public.loyalty_rewards'))[0].n, 1);

        await shiftVisitsBack(db, alice);
        const [redeemed] = await as(db, barber, () =>
            rows(db, 'select * from public.loyalty_redeem_reward($1)', [aliceCard.short_code]),
        );
        assert.equal(redeemed.available_rewards, 0);
        await shiftVisitsBack(db, alice);
        await assert.rejects(
            as(db, barber, () => db.query('select * from public.loyalty_redeem_reward($1)', [aliceCard.short_code])),
            /no_reward/,
        );
        const [card] = await as(db, alice, () => rows(db, 'select * from public.my_loyalty()'));
        assert.deepEqual(
            { stamps: card.stamps_total, available: card.available_rewards, redeemed: card.redeemed_rewards },
            { stamps: 10, available: 0, redeemed: 1 },
            'the free cut earns no stamp',
        );
    });

    test('the 20th stamp creates the second reward, never a duplicate', async () => {
        for (let i = 0; i < 10; i += 1) {
            await shiftVisitsBack(db, alice);
            await confirm(aliceCard.short_code);
        }
        const rewards = await rows(db, 'select cycle from public.loyalty_rewards order by cycle');
        assert.deepEqual(
            rewards.map((r) => r.cycle),
            [1, 2],
        );
    });

    test('data survives: the visit log keeps date, customer and who confirmed', async () => {
        const visits = await as(db, alice, () => rows(db, 'select kind, confirmed_by from public.loyalty_visits'));
        assert.equal(visits.length, 21);
        assert.ok(visits.every((v) => v.confirmed_by === barber));
        assert.equal(visits.filter((v) => v.kind === 'reward').length, 1);
    });
});

describe('payments (server functions, as called by the Edge Functions)', () => {
    let db;
    let admin;
    let alice;
    let bob;
    let fade;
    let booking;
    let payment;

    before(async () => {
        db = await createDb();
        admin = await signUp(db, 'admin@example.test');
        alice = await signUp(db, 'alice@example.test');
        bob = await signUp(db, 'bob@example.test');
        await db.query("update public.profiles set role = 'admin' where id = $1", [admin]);
        fade = await serviceId(db, 'degrade-bas'); // 15 €
        booking = await insertBooking(db, alice, fade);
    });

    after(() => db.close());

    const server = (sql, params) => as(db, 'service_role', () => rows(db, sql, params));
    const markPaid = (eventId, session, amount = 1500, livemode = false) =>
        server('select * from public.payment_mark_paid($1, $2, $3, $4, $5, $6, $7)', [
            eventId,
            'checkout.session.completed',
            session,
            'pi_123',
            amount,
            'eur',
            livemode,
        ]).then((r) => r[0]);

    test('payments are off by default; customers and visitors cannot call the server functions', async () => {
        await assert.rejects(
            server('select * from public.payment_create_pending($1, $2)', [booking, alice]),
            /payments_disabled/,
        );
        for (const who of [alice, 'anon']) {
            await as(db, who, async () => {
                await assert.rejects(
                    db.query('select * from public.payment_create_pending($1, $2)', [booking, alice]),
                    /permission denied for function/,
                );
                await assert.rejects(
                    db.query('select * from public.payment_mark_paid($1, $2, $3, $4, $5, $6, $7)', [
                        'evt',
                        't',
                        's',
                        'pi',
                        1500,
                        'eur',
                        true,
                    ]),
                    /permission denied for function/,
                );
            });
        }
    });

    test('only an admin can switch payments on', async () => {
        await as(db, alice, async () => {
            const { affectedRows } = await db.query(
                'update public.payment_settings set online_payments_enabled = true',
            );
            assert.equal(affectedRows, 0);
        });
        await as(db, admin, () => db.query('update public.payment_settings set online_payments_enabled = true'));
    });

    test('the amount comes from the service price, and only the booking owner can pay it', async () => {
        await assert.rejects(
            server('select * from public.payment_create_pending($1, $2)', [booking, bob]),
            /not_found/,
        );
        [payment] = await server('select * from public.payment_create_pending($1, $2)', [booking, alice]);
        assert.equal(payment.amount_cents, 1500);
        const [stored] = await rows(db, 'select barber_share_cents, status from public.payments where id = $1', [
            payment.payment_id,
        ]);
        assert.deepEqual(
            stored,
            { barber_share_cents: 1000, status: 'pending' },
            '15 € → 10 € indicative barber share',
        );
        await server('select public.payment_attach_session($1, $2)', [payment.payment_id, 'cs_test_1']);
    });

    test('a booking is "paid" only after a verified paid event, exactly once', async () => {
        const [before] = await as(db, alice, () =>
            rows(db, 'select status from public.payments where booking_id = $1', [booking]),
        );
        assert.equal(before.status, 'pending', 'returning from Stripe is not enough');

        const first = await markPaid('evt_1', 'cs_test_1');
        assert.equal(first.newly_paid, true);
        assert.equal(first.barber_share_cents, 1000);
        const replay = await markPaid('evt_1', 'cs_test_1');
        assert.equal(replay.newly_paid, false, 'same event replayed');
        const otherEvent = await markPaid('evt_2', 'cs_test_1');
        assert.equal(otherEvent.newly_paid, false, 'second event for the same session');
        assert.equal((await rows(db, 'select count(*)::int as n from public.staff_notifications'))[0].n, 1);
        await assert.rejects(
            server('select * from public.payment_create_pending($1, $2)', [booking, alice]),
            /already_paid/,
        );
    });

    test('the Telegram message can be claimed only once per payment', async () => {
        const claims = [];
        for (let i = 0; i < 3; i += 1) {
            const [r] = await server('select public.claim_telegram_notification($1) as ok', [payment.payment_id]);
            claims.push(r.ok);
        }
        assert.deepEqual(claims, [true, false, false]);
    });

    test('wrong amount, expiry and a second payment of the same booking are never counted as paid', async () => {
        const other = await insertBooking(db, alice, fade, 4);
        const [p2] = await server('select * from public.payment_create_pending($1, $2)', [other, alice]);
        await server('select public.payment_attach_session($1, $2)', [p2.payment_id, 'cs_test_2']);
        const wrong = await markPaid('evt_3', 'cs_test_2', 100);
        assert.equal(wrong.newly_paid, false);
        assert.equal(
            (await rows(db, 'select status from public.payments where id = $1', [p2.payment_id]))[0].status,
            'mismatch',
        );

        const [p3] = await server('select * from public.payment_create_pending($1, $2)', [other, alice]);
        await server('select public.payment_attach_session($1, $2)', [p3.payment_id, 'cs_test_3']);
        await server('select public.payment_mark_failed($1, $2, $3, $4)', [
            'evt_4',
            'checkout.session.expired',
            'cs_test_3',
            'expired',
        ]);
        assert.equal(
            (await rows(db, 'select status from public.payments where id = $1', [p3.payment_id]))[0].status,
            'expired',
        );

        // Two tabs: both sessions paid → the second is flagged for refund
        const [a] = await server('select * from public.payment_create_pending($1, $2)', [other, alice]);
        const [b] = await server('select * from public.payment_create_pending($1, $2)', [other, alice]);
        await server('select public.payment_attach_session($1, $2)', [a.payment_id, 'cs_a']);
        await server('select public.payment_attach_session($1, $2)', [b.payment_id, 'cs_b']);
        assert.equal((await markPaid('evt_5', 'cs_a')).newly_paid, true);
        assert.equal((await markPaid('evt_6', 'cs_b')).newly_paid, false);
        assert.equal(
            (await rows(db, 'select status from public.payments where id = $1', [b.payment_id]))[0].status,
            'duplicate',
        );
    });

    test('customers see their payment status but not the internal split; staff see the earnings card', async () => {
        await as(db, alice, async () => {
            const mine = await rows(db, 'select id, status, amount_cents from public.payments');
            assert.ok(mine.length >= 1);
            await assert.rejects(db.query('select barber_share_cents from public.payments'), /permission denied/);
            await assert.rejects(db.query('select * from public.barber_earnings()'), /forbidden/);
            assert.equal((await rows(db, 'select * from public.staff_notifications')).length, 0, 'staff only');
        });
        await as(db, bob, async () => {
            assert.equal((await rows(db, 'select id from public.payments')).length, 0, "Alice's payments are hidden");
        });
        const [earnings] = await as(db, admin, () => rows(db, 'select * from public.barber_earnings()'));
        assert.deepEqual(
            { live: earnings.livemode, count: earnings.payments_count, share: Number(earnings.barber_share_cents) },
            { live: false, count: 2, share: 2000 },
        );
    });
});
