// Internal messages customer ↔ salon (20261102110000_booking_messages.sql), on PGlite against the real
// migrations, not on the real Supabase project. Run with: npm test
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { as, createDb, rows, signUp } from './helpers.mjs';

describe('booking messages', () => {
    let db;
    let alice;
    let bob;
    let zeyd;
    let aliceBooking;
    let bobBooking;
    let day = 2;

    const book = async (customer) => {
        const [{ id: service }] = await rows(db, "select id from public.services where slug = 'degrade-bas'");
        const [b] = await rows(
            db,
            `insert into public.bookings (customer_id, service_id, starts_at, ends_at, status)
             values ($1, $2, now() + $3 * interval '1 day', now() + $3 * interval '1 day' + interval '35 minutes', 'confirmed')
             returning id`,
            [customer, service, ++day], // one day apart: one chair, no overlap
        );
        return b.id;
    };
    const customerSend = (who, booking, body) =>
        as(db, who, () => rows(db, 'select * from public.customer_send_message($1, $2)', [booking, body]));
    const staffSend = (who, booking, body) =>
        as(db, who, () => rows(db, 'select * from public.staff_send_message($1, $2)', [booking, body]));
    const visible = (who) =>
        as(db, who, () => rows(db, 'select booking_id, from_staff, body, read_at from public.booking_messages'));

    before(async () => {
        db = await createDb();
        alice = await signUp(db, 'alice@example.test');
        bob = await signUp(db, 'bob@example.test');
        zeyd = await signUp(db, 'zeyd@example.test');
        await db.query("update public.profiles set role = 'barber' where id = $1", [zeyd]);
        aliceBooking = await book(alice);
        bobBooking = await book(bob);
    });

    after(() => db.close());

    test('a customer writes about their own booking only', async () => {
        const [sent] = await customerSend(alice, aliceBooking, '  Je serai 10 minutes en retard  ');
        assert.ok(sent.id);
        await assert.rejects(customerSend(alice, bobBooking, 'hello'), /not_found/);
        await assert.rejects(customerSend(alice, aliceBooking, '   '), /message_empty/);
        await assert.rejects(customerSend(alice, aliceBooking, 'x'.repeat(1001)), /message_too_long/);
        const [stored] = await rows(db, 'select body, from_staff, customer_id from public.booking_messages');
        assert.deepEqual(stored, { body: 'Je serai 10 minutes en retard', from_staff: false, customer_id: alice });
    });

    test('a visitor can do nothing, a customer cannot write to the table directly', async () => {
        await as(db, 'anon', async () => {
            await assert.rejects(db.query('select * from public.booking_messages'), /permission denied/);
            await assert.rejects(
                db.query('select * from public.customer_send_message($1, $2)', [aliceBooking, 'x']),
                /permission denied/,
            );
        });
        await as(db, alice, async () => {
            await assert.rejects(
                db.query(
                    "insert into public.booking_messages (booking_id, customer_id, from_staff, body) values ($1, $2, true, 'fake')",
                    [aliceBooking, alice],
                ),
                /permission denied/,
            );
            await assert.rejects(db.query('update public.booking_messages set read_at = now()'), /permission denied/);
        });
    });

    test('each customer sees only their own messages; staff see all', async () => {
        await customerSend(bob, bobBooking, 'Question de Bob');
        assert.deepEqual(
            (await visible(alice)).map((m) => m.body),
            ['Je serai 10 minutes en retard'],
        );
        assert.deepEqual(
            (await visible(bob)).map((m) => m.body),
            ['Question de Bob'],
        );
        assert.equal((await visible(zeyd)).length, 2);
    });

    test('only staff can send as the salon; the message goes to the customer of the booking', async () => {
        await assert.rejects(staffSend(alice, aliceBooking, 'fake'), /forbidden/);
        await staffSend(zeyd, aliceBooking, 'Pas de souci, à samedi.');
        const salon = (await visible(alice)).filter((m) => m.from_staff);
        assert.deepEqual(
            salon.map((m) => m.body),
            ['Pas de souci, à samedi.'],
        );
        assert.equal((await visible(bob)).filter((m) => m.from_staff).length, 0);
    });

    test('unread until opened: each side marks only the messages addressed to it', async () => {
        const unread = async (who, fromStaff) =>
            (await visible(who)).filter((m) => m.from_staff === fromStaff && !m.read_at).length;
        assert.equal(await unread(alice, true), 1, 'Alice has one new message from the salon');
        assert.equal(await unread(zeyd, false), 2, 'Zeyd has two new customer messages');

        const [{ mark_my_messages_read: n }] = await as(db, alice, () =>
            rows(db, 'select public.mark_my_messages_read($1)', [aliceBooking]),
        );
        assert.equal(n, 1);
        assert.equal(await unread(alice, true), 0);
        assert.equal(await unread(zeyd, false), 2, "Alice's reading does not mark her own messages read");

        await assert.rejects(
            as(db, alice, () => db.query('select public.staff_mark_messages_read($1)', [aliceBooking])),
            /forbidden/,
        );
        await as(db, zeyd, () => db.query('select public.staff_mark_messages_read($1)', [aliceBooking]));
        assert.equal(await unread(zeyd, false), 1, "only the booking opened (Bob's message stays new)");
    });

    test('at most 10 customer messages per booking in 24 hours', async () => {
        const booking = await book(alice);
        for (let i = 0; i < 10; i += 1) await customerSend(alice, booking, `message ${i}`);
        await assert.rejects(customerSend(alice, booking, 'one too many'), /too_many_messages/);
    });

    test('messages never change a booking', async () => {
        const [b] = await rows(db, 'select status from public.bookings where id = $1', [aliceBooking]);
        assert.equal(b.status, 'confirmed');
    });
});
