// Phase 6 stage B: cancellation with a reason, rescheduling, history and Zeyd's notification queue.
// Run on PGlite against the real migrations: npm test
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { as, createDb, rows, signUp } from './helpers.mjs';

const TZ = 'Europe/Paris';

async function serviceId(db, slug) {
    return (await rows(db, 'select id from public.services where slug = $1', [slug]))[0].id;
}

async function nextOpenDay(db, isodow) {
    const [row] = await rows(
        db,
        `select day::text from public.bookable_days()
         where extract(isodow from day) = $1 and day >= (now() at time zone '${TZ}')::date + 2
         order by day limit 1`,
        [isodow],
    );
    return row.day;
}

const at = async (db, day, hhmi) =>
    (await rows(db, `select ($1::date + $2::time) at time zone '${TZ}' as ts`, [day, hhmi]))[0].ts;

const isOffered = async (db, service, day, ts) =>
    (await rows(db, 'select 1 from public.available_slots($1, $2) where starts_at = $3', [service, day, ts])).length >
    0;

const book = async (db, who, service, ts) =>
    as(db, who, async () => (await rows(db, 'select * from public.book_appointment($1, $2)', [service, ts]))[0].id);

const cancel = (db, id, code, details = null) =>
    db.query('select * from public.cancel_my_booking($1, $2, $3)', [id, code, details]);

describe('customer cancellation with a reason', () => {
    let db;
    let alice;
    let bob;
    let admin;
    let fade;
    let monday;

    before(async () => {
        db = await createDb();
        alice = await signUp(db, 'alice@example.test', { full_name: 'Alice Martin' });
        bob = await signUp(db, 'bob@example.test');
        admin = await signUp(db, 'admin@example.test');
        await db.query("update public.profiles set role = 'admin' where id = $1", [admin]);
        fade = await serviceId(db, 'degrade-bas');
        monday = await nextOpenDay(db, 1);
        // Several bookings per customer in these tests (the limit itself is tested in booking.test.mjs)
        await db.query('update public.booking_settings set max_active_bookings = 20');
    });

    after(() => db.close());

    test('the reason is required and must be one of the list; details are limited to 500 characters', async () => {
        const id = await book(db, alice, fade, await at(db, monday, '09:00'));
        await as(db, alice, async () => {
            await assert.rejects(cancel(db, id, null), /invalid_reason/);
            await assert.rejects(cancel(db, id, 'because'), /invalid_reason/);
            await assert.rejects(cancel(db, id, 'unavailable', 'x'.repeat(501)), /details_too_long/);
            await assert.rejects(cancel(db, id, 'other', 'x'.repeat(501)), /details_too_long/);
        });
        const [b] = await rows(db, 'select status from public.bookings where id = $1', [id]);
        assert.equal(b.status, 'confirmed', 'a refused request changes nothing');
    });

    test('only the owner can cancel; nobody else, signed in or not', async () => {
        const id = await book(db, alice, fade, await at(db, monday, '10:00'));
        await as(db, bob, async () => {
            await assert.rejects(cancel(db, id, 'unavailable'), /not_found/);
        });
        await as(db, 'anon', async () => {
            await assert.rejects(cancel(db, id, 'unavailable'), /permission denied|auth_required/);
        });
        // Staff use their own function (staff_cancel_booking), not the customer one
        await as(db, admin, async () => {
            await assert.rejects(cancel(db, id, 'unavailable'), /not_found/);
        });
    });

    test('a confirmed cancellation stores the reason and frees the slot, only once it succeeded', async () => {
        const ts = await at(db, monday, '11:00');
        const id = await book(db, alice, fade, ts);
        assert.equal(await isOffered(db, fade, monday, ts), false, 'taken while booked');
        await as(db, alice, async () => {
            await assert.rejects(cancel(db, id, 'because'), /invalid_reason/);
        });
        assert.equal(await isOffered(db, fade, monday, ts), false, 'still taken after a refused cancellation');

        await as(db, alice, () => cancel(db, id, 'unavailable', '  Un empêchement au travail  '));
        const [b] = await rows(
            db,
            'select status, cancel_reason_code, cancel_details, cancelled_by, cancelled_at from public.bookings where id = $1',
            [id],
        );
        assert.equal(b.status, 'cancelled');
        assert.equal(b.cancel_reason_code, 'unavailable');
        assert.equal(b.cancel_details, 'Un empêchement au travail');
        assert.equal(b.cancelled_by, alice);
        assert.ok(b.cancelled_at);
        assert.equal(await isOffered(db, fade, monday, ts), true, 'free again for everybody');
        // Bob can now book it: the database, not the page, decides
        assert.ok(await book(db, bob, fade, ts));
    });

    test('« Autre raison » can be chosen without writing anything (20261102090000)', async () => {
        const ts = await at(db, monday, '15:00');
        const id = await book(db, alice, fade, ts);
        await as(db, alice, () => cancel(db, id, 'other', '   '));
        const [b] = await rows(
            db,
            'select status, cancel_reason_code, cancel_details from public.bookings where id = $1',
            [id],
        );
        assert.deepEqual(b, { status: 'cancelled', cancel_reason_code: 'other', cancel_details: null });
        assert.equal(await isOffered(db, fade, monday, ts), true, 'free again');
    });

    test('a second click or a second tab cannot cancel twice nor notify twice', async () => {
        const id = await book(db, alice, fade, await at(db, monday, '14:00'));
        await as(db, alice, () => cancel(db, id, 'time_unsuitable'));
        await as(db, alice, async () => {
            await assert.rejects(cancel(db, id, 'time_unsuitable'), /invalid_status/);
        });
        const notes = await rows(
            db,
            'select kind, telegram_status, data from public.staff_notifications where booking_id = $1',
            [id],
        );
        assert.equal(notes.length, 1);
        assert.equal(notes[0].kind, 'cancellation');
        assert.equal(notes[0].telegram_status, 'pending');
        assert.equal(notes[0].data.customer_name, 'Alice Martin');
        assert.equal(notes[0].data.reason_code, 'time_unsuitable');
    });

    test('the history keeps who created and cancelled, when and why', async () => {
        const id = await book(db, alice, fade, await at(db, monday, '15:00'));
        await as(db, alice, () => cancel(db, id, 'price_service', 'Trop cher pour moi'));
        const events = await rows(
            db,
            'select action, actor_id, by_customer, reason_code, details from public.booking_events where booking_id = $1 order by created_at, action',
            [id],
        );
        assert.deepEqual(events.map((e) => e.action).sort(), ['cancelled', 'created']);
        const cancelled = events.find((e) => e.action === 'cancelled');
        assert.equal(cancelled.actor_id, alice);
        assert.equal(cancelled.by_customer, true);
        assert.equal(cancelled.reason_code, 'price_service');
        assert.equal(cancelled.details, 'Trop cher pour moi');
    });

    test('a cancellation by the salon is in the history but is not sent to Zeyd as a customer cancellation', async () => {
        const id = await book(db, alice, fade, await at(db, monday, '16:00'));
        await as(db, admin, () =>
            db.query('select * from public.staff_cancel_booking($1, $2)', [id, 'Fermeture imprévue']),
        );
        assert.equal(
            (await rows(db, 'select 1 from public.staff_notifications where booking_id = $1', [id])).length,
            0,
        );
        const [e] = await rows(
            db,
            "select by_customer, details from public.booking_events where booking_id = $1 and action = 'cancelled'",
            [id],
        );
        assert.equal(e.by_customer, false);
        assert.equal(e.details, 'Fermeture imprévue');
    });

    test('too close to the appointment the customer cannot cancel (same rule as before)', async () => {
        const [b] = await rows(
            db,
            `insert into public.bookings (customer_id, service_id, starts_at, ends_at, status)
             values ($1, $2, now() + interval '30 minutes', now() + interval '65 minutes', 'confirmed') returning id`,
            [alice, fade],
        );
        await as(db, alice, async () => {
            await assert.rejects(cancel(db, b.id, 'unavailable'), /too_late_to_cancel/);
        });
    });

    test('customers can read neither the history nor the notifications; only the server sends', async () => {
        await as(db, alice, async () => {
            assert.equal((await rows(db, 'select * from public.booking_events')).length, 0);
            assert.equal((await rows(db, 'select * from public.staff_notifications')).length, 0);
            await assert.rejects(
                db.query('select * from public.staff_notification_claim(null, null, true)'),
                /permission denied/,
            );
        });
        await as(db, admin, async () => {
            assert.ok((await rows(db, 'select * from public.booking_events')).length > 0);
            assert.ok((await rows(db, 'select * from public.staff_notifications')).length > 0);
        });
    });
});

describe('rescheduling: all or nothing', () => {
    let db;
    let alice;
    let bob;
    let fade;
    let friday;

    before(async () => {
        db = await createDb();
        alice = await signUp(db, 'alice@example.test', { full_name: 'Alice' });
        bob = await signUp(db, 'bob@example.test');
        fade = await serviceId(db, 'degrade-bas');
        friday = await nextOpenDay(db, 5);
        await db.query('update public.booking_settings set max_active_bookings = 20');
    });

    after(() => db.close());

    const reschedule = (id, ts) => db.query('select * from public.reschedule_my_booking($1, $2)', [id, ts]);

    test('moving to a free slot cancels the old one and books the new one together', async () => {
        const oldTs = await at(db, friday, '09:00');
        const newTs = await at(db, friday, '10:30');
        const oldId = await book(db, alice, fade, oldTs);
        const [moved] = await as(db, alice, async () => (await reschedule(oldId, newTs)).rows);
        const [o] = await rows(db, 'select status, cancel_reason_code from public.bookings where id = $1', [oldId]);
        const [n] = await rows(db, 'select status, rescheduled_from, starts_at from public.bookings where id = $1', [
            moved.id,
        ]);
        assert.equal(o.status, 'cancelled');
        assert.equal(o.cancel_reason_code, 'reschedule');
        assert.equal(n.status, 'confirmed');
        assert.equal(n.rescheduled_from, oldId);
        assert.equal(new Date(n.starts_at).getTime(), new Date(newTs).getTime());
        assert.equal(await isOffered(db, fade, friday, oldTs), true, 'old slot free');
        const [note] = await rows(
            db,
            "select data from public.staff_notifications where kind = 'reschedule' and booking_id = $1",
            [oldId],
        );
        assert.equal(new Date(note.data.new_starts_at).getTime(), new Date(newTs).getTime());
    });

    test('moving 15 minutes later (overlapping the old slot) works too', async () => {
        const oldId = await book(db, alice, fade, await at(db, friday, '14:00'));
        const [moved] = await as(db, alice, async () => (await reschedule(oldId, await at(db, friday, '14:15'))).rows);
        assert.ok(moved.id);
    });

    test('if the new slot is taken, nothing changes: the customer keeps the original appointment', async () => {
        const oldId = await book(db, alice, fade, await at(db, friday, '16:00'));
        const taken = await at(db, friday, '17:00');
        await book(db, bob, fade, taken);
        await as(db, alice, async () => {
            await assert.rejects(reschedule(oldId, taken), /slot_unavailable/);
            await assert.rejects(reschedule(oldId, await at(db, friday, '12:30')), /slot_unavailable/); // lunch break
        });
        const [o] = await rows(db, 'select status, cancel_reason_code from public.bookings where id = $1', [oldId]);
        assert.equal(o.status, 'confirmed');
        assert.equal(o.cancel_reason_code, null);
        assert.equal(
            (await rows(db, 'select 1 from public.staff_notifications where booking_id = $1', [oldId])).length,
            0,
        );
    });

    test("nobody can move someone else's booking", async () => {
        const oldId = await book(db, alice, fade, await at(db, friday, '18:00'));
        await as(db, bob, async () => {
            await assert.rejects(reschedule(oldId, await at(db, friday, '18:30')), /not_found/);
        });
    });
});

describe('notification queue (server side)', () => {
    let db;
    let alice;
    let fade;
    let saturday;

    before(async () => {
        db = await createDb();
        alice = await signUp(db, 'alice@example.test');
        fade = await serviceId(db, 'degrade-bas');
        saturday = await nextOpenDay(db, 6);
    });

    after(() => db.close());

    const claim = (id, bookingId, retry) =>
        as(db, 'service_role', async () =>
            rows(db, 'select * from public.staff_notification_claim($1, $2, $3)', [id, bookingId, retry]),
        );
    const result = (id, status, error = null) =>
        as(db, 'service_role', () =>
            db.query('select public.staff_notification_result($1, $2, $3)', [id, status, error]),
        );

    test('a notification is claimed by one sender only, then marked sent; a refresh sends nothing more', async () => {
        const id = await book(db, alice, fade, await at(db, saturday, '09:00'));
        await as(db, alice, () => cancel(db, id, 'unavailable'));
        const first = await claim(null, id, false);
        const second = await claim(null, id, false);
        assert.equal(first.length, 1);
        assert.equal(second.length, 0, 'already being sent');
        await result(first[0].id, 'sent');
        assert.equal((await claim(null, id, true)).length, 0, 'sent: never again, even with retry');
        const [n] = await rows(
            db,
            'select telegram_status, telegram_sent_at from public.staff_notifications where id = $1',
            [first[0].id],
        );
        assert.equal(n.telegram_status, 'sent');
        assert.ok(n.telegram_sent_at);
    });

    test('a failed message stays visible and can be retried only on purpose', async () => {
        const id = await book(db, alice, fade, await at(db, saturday, '10:00'));
        await as(db, alice, () => cancel(db, id, 'dissatisfied'));
        const [c] = await claim(null, id, false);
        await result(c.id, 'failed', 'Telegram HTTP 502');
        assert.equal((await claim(null, id, false)).length, 0, 'no automatic re-send');
        assert.equal((await claim(c.id, null, true)).length, 1, 'staff retry');
        const [n] = await rows(
            db,
            'select telegram_status, telegram_attempts from public.staff_notifications where id = $1',
            [c.id],
        );
        assert.equal(n.telegram_status, 'sending');
        assert.equal(n.telegram_attempts, 2);
    });

    test('the cancellation never depends on the message: it is stored even if nothing is ever sent', async () => {
        const id = await book(db, alice, fade, await at(db, saturday, '11:00'));
        await as(db, alice, () => cancel(db, id, 'other', 'Déménagement'));
        const [b] = await rows(db, 'select status, cancel_details from public.bookings where id = $1', [id]);
        assert.equal(b.status, 'cancelled');
        assert.equal(b.cancel_details, 'Déménagement');
    });
});
