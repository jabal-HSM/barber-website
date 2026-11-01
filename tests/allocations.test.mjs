// Phase 6 stage E: payment records and the 10 € / 5 € allocation, in integer cents. Run with: npm test
// No real payment: Stripe events are simulated through the same server-only functions the webhook uses.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { allocate } from '../supabase/functions/_shared/allocation.ts';
import { handleStripeEvent } from '../supabase/functions/_shared/webhook.ts';
import { as, createDb, rows, signUp } from './helpers.mjs';

describe('allocation rule (pure)', () => {
    test('10 € → Zeyd 10 €, mother 0 €; 15 € → Zeyd 10 €, mother 5 €', () => {
        assert.deepEqual(allocate(1000), { qualifying: true, zeydCents: 1000, motherCents: 0 });
        assert.deepEqual(allocate(1500), { qualifying: true, zeydCents: 1000, motherCents: 500 });
    });

    test('other amounts, or an amount that is not the service price, are never split', () => {
        for (const cents of [500, 1200, 2000, 1499, 15, 0, -1500, 15.5]) {
            assert.equal(allocate(cents).qualifying, false, String(cents));
        }
        assert.equal(allocate(1500, 1000).qualifying, false, '15 € paid for a 10 € service');
    });

    test('Zeyd + mother always equals the amount (no rounding, integers only)', () => {
        for (const cents of [1000, 1500]) {
            const a = allocate(cents);
            assert.equal(a.zeydCents + a.motherCents, cents);
            assert.ok(Number.isInteger(a.zeydCents) && Number.isInteger(a.motherCents));
        }
    });
});

describe('payment records and allocations (database)', () => {
    let db;
    let admin;
    let zeyd;
    let alice;
    let fade; // 15 €
    let kids; // 10 €

    const booking = async (customer, service) =>
        (
            await rows(
                db,
                `insert into public.bookings (customer_id, service_id, starts_at, ends_at, status)
                 values ($1, $2, now() + random() * interval '20 days' + interval '2 days', null, 'confirmed') returning id`,
                [customer, service],
            )
        )[0].id;

    // Same path as the Stripe webhook: pending payment → session → signed "paid" event (simulated)
    async function stripePaid(bookingId, eventId, amount) {
        return as(db, 'service_role', async () => {
            const [p] = await rows(db, 'select * from public.payment_create_pending($1, $2)', [bookingId, alice]);
            await db.query('select public.payment_attach_session($1, $2)', [p.payment_id, `cs_${eventId}`]);
            const [r] = await rows(db, 'select * from public.payment_mark_paid($1, $2, $3, $4, $5, $6, $7)', [
                eventId,
                'checkout.session.completed',
                `cs_${eventId}`,
                `pi_${eventId}`,
                amount ?? p.amount_cents,
                'eur',
                false,
            ]);
            return { paymentId: p.payment_id, ...r };
        });
    }

    before(async () => {
        db = await createDb();
        admin = await signUp(db, 'admin@example.test', { full_name: 'Admin' });
        zeyd = await signUp(db, 'zeyd@example.test', { full_name: 'Zeyd' });
        alice = await signUp(db, 'alice@example.test', { full_name: 'Alice' });
        await db.query("update public.profiles set role = 'admin' where id = $1", [admin]);
        await db.query("update public.profiles set role = 'barber' where id = $1", [zeyd]);
        await db.query("update public.services set duration_minutes = 30 where slug = 'coupe-enfant'");
        fade = (await rows(db, "select id from public.services where slug = 'degrade-bas'"))[0].id;
        kids = (await rows(db, "select id from public.services where slug = 'coupe-enfant'"))[0].id;
        await db.query('update public.payment_settings set online_payments_enabled = true');
    });

    after(() => db.close());

    test('the database rule gives exactly the same numbers as the server code', async () => {
        for (const [amount, price] of [
            [1000, 1000],
            [1500, 1500],
            [1500, 1000],
            [1200, 1200],
            [2000, 2000],
        ]) {
            const [r] = await as(db, 'service_role', () =>
                rows(db, 'select * from public.payment_allocation($1, $2)', [amount, price]),
            );
            const ts = allocate(amount, price);
            assert.equal(r.qualifying, ts.qualifying, `${amount}/${price}`);
            assert.equal(r.zeyd_cents, ts.zeydCents);
            assert.equal(r.mother_cents, ts.motherCents);
        }
    });

    test('a paid 15 € Stripe payment is recorded once: Zeyd 10 €, mother 5 € to transfer', async () => {
        const b = await booking(alice, fade);
        const { paymentId } = await stripePaid(b, 'evt_15');
        const [a] = await rows(db, 'select * from public.payment_allocations where payment_id = $1', [paymentId]);
        assert.equal(a.amount_cents, 1500);
        assert.equal(a.zeyd_cents, 1000);
        assert.equal(a.mother_cents, 500);
        assert.equal(a.status, 'recorded');
        assert.equal(a.mother_transfer, 'to_transfer', 'recorded, not transferred: no money has moved');
        const [p] = await rows(db, 'select barber_share_cents from public.payments where id = $1', [paymentId]);
        assert.equal(p.barber_share_cents, 1000);
    });

    test('a 10 € payment gives Zeyd the full 10 € (the old rule gave 5 €) and nothing to transfer', async () => {
        const b = await booking(alice, kids);
        const { paymentId } = await stripePaid(b, 'evt_10');
        const [a] = await rows(db, 'select * from public.payment_allocations where payment_id = $1', [paymentId]);
        assert.equal(a.zeyd_cents, 1000);
        assert.equal(a.mother_cents, 0);
        assert.equal(a.mother_transfer, 'not_due');
    });

    test('the same Stripe event replayed, or a second session for the same booking, never allocates twice', async () => {
        const b = await booking(alice, fade);
        const first = await stripePaid(b, 'evt_dup');
        const replay = await as(db, 'service_role', () =>
            rows(db, 'select * from public.payment_mark_paid($1, $2, $3, $4, $5, $6, $7)', [
                'evt_dup',
                'checkout.session.completed',
                'cs_evt_dup',
                'pi_evt_dup',
                1500,
                'eur',
                false,
            ]),
        );
        assert.equal(replay[0].newly_paid, false);
        // A second tab could not even open a new payment now: payment_create_pending refuses
        await as(db, 'service_role', async () => {
            await assert.rejects(
                db.query('select * from public.payment_create_pending($1, $2)', [b, alice]),
                /already_paid/,
            );
        });
        // Two tabs opened before either was paid: the second "paid" is flagged as duplicate
        const b2 = await booking(alice, fade);
        const [s1, s2] = await as(db, 'service_role', async () => {
            const p1 = (await rows(db, 'select * from public.payment_create_pending($1, $2)', [b2, alice]))[0];
            await db.query("select public.payment_attach_session($1, 'cs_tab1')", [p1.payment_id]);
            await db.query("update public.payments set status = 'expired' where id = $1", [p1.payment_id]);
            const p2 = (await rows(db, 'select * from public.payment_create_pending($1, $2)', [b2, alice]))[0];
            await db.query("select public.payment_attach_session($1, 'cs_tab2')", [p2.payment_id]);
            await db.query("update public.payments set status = 'pending' where id = $1", [p1.payment_id]);
            return [p1, p2];
        });
        const mark = (eventId, session) =>
            as(db, 'service_role', () =>
                rows(db, 'select * from public.payment_mark_paid($1, $2, $3, $4, $5, $6, $7)', [
                    eventId,
                    'checkout.session.completed',
                    session,
                    `pi_${eventId}`,
                    1500,
                    'eur',
                    false,
                ]),
            );
        assert.equal((await mark('evt_tab1', 'cs_tab1'))[0].newly_paid, true);
        assert.equal((await mark('evt_tab2', 'cs_tab2'))[0].newly_paid, false, 'second tab → duplicate');
        const [dup] = await rows(db, 'select status from public.payments where id = $1', [s2.payment_id]);
        assert.equal(dup.status, 'duplicate');
        assert.equal(
            (
                await rows(db, 'select 1 from public.payment_allocations where payment_id in ($1, $2)', [
                    s1.payment_id,
                    s2.payment_id,
                ])
            ).length,
            1,
        );
        const allocations = await rows(
            db,
            'select pa.* from public.payment_allocations pa join public.payments p on p.id = pa.payment_id where p.booking_id = $1',
            [b],
        );
        assert.equal(allocations.length, 1);
        assert.equal(allocations[0].payment_id, first.paymentId);
        const issues = await rows(db, "select data from public.staff_notifications where kind = 'payment_issue'");
        assert.ok(
            issues.some((n) => n.data.status === 'duplicate'),
            'Zeyd sees the double payment',
        );
    });

    test('a payment with the wrong amount is never marked paid nor allocated', async () => {
        const b = await booking(alice, fade);
        const { paymentId } = await stripePaid(b, 'evt_bad', 999);
        const [p] = await rows(db, 'select status from public.payments where id = $1', [paymentId]);
        assert.equal(p.status, 'mismatch');
        assert.equal(
            (await rows(db, 'select 1 from public.payment_allocations where payment_id = $1', [paymentId])).length,
            0,
        );
    });

    test('cash or a bank transfer is recorded by staff only; a transfer needs its bank reference', async () => {
        const b = await booking(alice, fade);
        await as(db, alice, async () => {
            await assert.rejects(
                db.query("select * from public.staff_record_payment($1, 1500, 'cash')", [b]),
                /forbidden/,
            );
        });
        await as(db, zeyd, async () => {
            await assert.rejects(
                db.query("select * from public.staff_record_payment($1, 1500, 'bank_transfer')", [b]),
                /reference_required/,
            );
            await assert.rejects(
                db.query("select * from public.staff_record_payment($1, 1500, 'bitcoin')", [b]),
                /invalid_method/,
            );
            const [r] = await rows(
                db,
                "select * from public.staff_record_payment($1, 1500, 'bank_transfer', 'VIR 123')",
                [b],
            );
            assert.equal(r.allocation_status, 'recorded');
            assert.equal(r.zeyd_cents, 1000);
            assert.equal(r.mother_cents, 500);
            await assert.rejects(
                db.query("select * from public.staff_record_payment($1, 1500, 'cash')", [b]),
                /already_paid/,
            );
        });
        const [p] = await rows(
            db,
            "select method, reference, confirmed_by from public.payments where booking_id = $1 and status = 'paid'",
            [b],
        );
        assert.deepEqual([p.method, p.reference, p.confirmed_by], ['bank_transfer', 'VIR 123', zeyd]);
    });

    test('an amount that does not match the service is recorded as "needs review", never split', async () => {
        const b = await booking(alice, fade);
        const [r] = await as(db, zeyd, () =>
            rows(db, "select * from public.staff_record_payment($1, 1200, 'cash')", [b]),
        );
        assert.equal(r.allocation_status, 'needs_review');
        assert.equal(r.zeyd_cents, null);
        assert.equal(r.mother_cents, null);
    });

    test("only an admin marks the mother's share as really transferred, and only once", async () => {
        const b = await booking(alice, fade);
        const [r] = await as(db, zeyd, () =>
            rows(db, "select * from public.staff_record_payment($1, 1500, 'cash')", [b]),
        );
        await as(db, zeyd, async () => {
            await assert.rejects(db.query('select public.staff_mark_mother_transfer($1)', [r.payment_id]), /forbidden/);
        });
        await as(db, admin, async () => {
            await db.query("select public.staff_mark_mother_transfer($1, 'Virement 01/11')", [r.payment_id]);
            await assert.rejects(
                db.query('select public.staff_mark_mother_transfer($1)', [r.payment_id]),
                /nothing_to_transfer/,
            );
        });
        const [a] = await rows(
            db,
            'select mother_transfer, transferred_by, transfer_reference from public.payment_allocations where payment_id = $1',
            [r.payment_id],
        );
        assert.deepEqual(
            [a.mother_transfer, a.transferred_by, a.transfer_reference],
            ['transferred', admin, 'Virement 01/11'],
        );
    });

    test('customers can neither read nor change allocations, nor list payments', async () => {
        await as(db, alice, async () => {
            assert.equal((await rows(db, 'select * from public.payment_allocations')).length, 0);
            await assert.rejects(db.query('update public.payment_allocations set zeyd_cents = 0'), /permission denied/);
            await assert.rejects(db.query('select * from public.payment_records()'), /forbidden/);
            await assert.rejects(db.query('select * from public.allocation_summary()'), /forbidden/);
            await assert.rejects(db.query('select * from public.payment_allocation(1500, 1500)'), /permission denied/);
        });
    });

    test('the summary adds up per mode, in cents', async () => {
        const summary = await as(db, zeyd, () => rows(db, 'select * from public.allocation_summary()'));
        const total = summary.reduce((s, r) => s + Number(r.amount_cents), 0);
        const split = summary.reduce((s, r) => s + Number(r.zeyd_cents) + Number(r.mother_cents), 0);
        const review = summary.reduce((s, r) => s + r.needs_review_count, 0);
        assert.equal(review, 1);
        assert.equal(total - split, 1200, 'only the needs-review payment is outside the split');
        const records = await as(db, zeyd, () => rows(db, 'select * from public.payment_records()'));
        assert.ok(records.length >= 6);
        assert.ok(records.every((r) => r.status !== 'pending'));
    });
});

describe("Hashem's Telegram message follows the 5 € share", () => {
    const event = (amount) => ({
        id: `evt_${amount}`,
        type: 'checkout.session.completed',
        livemode: true,
        data: {
            object: { id: 'cs', payment_status: 'paid', payment_intent: 'pi', amount_total: amount, currency: 'eur' },
        },
    });
    const deps = (amount, sent) => ({
        notifyTestPayments: false,
        sendTelegram: async (t) => {
            sent.push(t);
            return { ok: true };
        },
        rpc: async (name) =>
            name === 'payment_mark_paid'
                ? [{ payment_id: 'p1', newly_paid: true, livemode: true, amount_cents: amount }]
                : true,
    });

    test('15 € (mother 5 €) → the message is sent once', async () => {
        const sent = [];
        const r = await handleStripeEvent(event(1500), deps(1500, sent));
        assert.equal(r.telegram, 'sent');
        assert.equal(sent.length, 1);
    });

    test('10 € (mother 0 €) → no "5 euros" message', async () => {
        const sent = [];
        const r = await handleStripeEvent(event(1000), deps(1000, sent));
        assert.equal(r.telegram, 'not_due');
        assert.equal(sent.length, 0);
    });
});
