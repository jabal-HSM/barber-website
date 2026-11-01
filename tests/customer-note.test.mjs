// The message a customer writes when booking (e.g. « السلام عليكم ») : where it is stored, who can read it,
// and that it survives a rescheduling. Also: changing a price later never changes a payment already made.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { as, createDb, rows, signUp } from './helpers.mjs';

const TZ = 'Europe/Paris';

describe('customer note and price history', () => {
    let db;
    let alice;
    let bob;
    let zeyd;
    let fade;
    let monday;

    const at = async (day, hhmi) =>
        (await rows(db, `select ($1::date + $2::time) at time zone '${TZ}' as ts`, [day, hhmi]))[0].ts;

    before(async () => {
        db = await createDb();
        alice = await signUp(db, 'alice@example.test', { full_name: 'Alice' });
        bob = await signUp(db, 'bob@example.test');
        zeyd = await signUp(db, 'zeyd@example.test');
        await db.query("update public.profiles set role = 'barber' where id = $1", [zeyd]);
        await db.query('update public.booking_settings set max_active_bookings = 10');
        fade = (await rows(db, "select id from public.services where slug = 'degrade-bas'"))[0].id;
        monday = (
            await rows(
                db,
                `select day::text from public.bookable_days() where extract(isodow from day) = 1
                 and day >= (now() at time zone '${TZ}')::date + 2 order by day limit 1`,
            )
        )[0].day;
    });

    after(() => db.close());

    test('the note typed when booking is stored as typed in bookings.customer_note (trimmed only)', async () => {
        const [b] = await as(db, alice, async () =>
            rows(db, 'select * from public.book_appointment($1, $2, $3)', [
                fade,
                await at(monday, '09:00'),
                '  السلام عليكم  ',
            ]),
        );
        const [row] = await rows(db, 'select customer_note from public.bookings where id = $1', [b.id]);
        assert.equal(row.customer_note, 'السلام عليكم');
    });

    test('Zeyd reads it, the customer reads their own, nobody else does', async () => {
        const [b] = await as(db, alice, async () =>
            rows(db, 'select * from public.book_appointment($1, $2, $3)', [
                fade,
                await at(monday, '10:00'),
                'Bonjour, un peu plus court svp',
            ]),
        );
        const read = (who) =>
            as(db, who, () => rows(db, 'select customer_note from public.bookings where id = $1', [b.id]));
        assert.equal((await read(zeyd))[0]?.customer_note, 'Bonjour, un peu plus court svp');
        assert.equal((await read(alice))[0]?.customer_note, 'Bonjour, un peu plus court svp');
        assert.equal((await read(bob)).length, 0, 'another customer sees nothing');
        await as(db, 'anon', async () => {
            await assert.rejects(db.query('select customer_note from public.bookings'), /permission denied/);
        });
    });

    test('an empty note is stored as nothing, a very long one is refused', async () => {
        const [b] = await as(db, alice, async () =>
            rows(db, 'select * from public.book_appointment($1, $2, $3)', [fade, await at(monday, '11:00'), '   ']),
        );
        assert.equal(
            (await rows(db, 'select customer_note from public.bookings where id = $1', [b.id]))[0].customer_note,
            null,
        );
        await as(db, alice, async () => {
            await assert.rejects(
                db.query('select * from public.book_appointment($1, $2, $3)', [
                    fade,
                    await at(monday, '14:00'),
                    'x'.repeat(2000),
                ]),
                /check|note/i,
            );
        });
    });

    test('the note follows the booking when it is moved to another time', async () => {
        const [b] = await as(db, alice, async () =>
            rows(db, 'select * from public.book_appointment($1, $2, $3)', [
                fade,
                await at(monday, '15:00'),
                'السلام عليكم',
            ]),
        );
        const [moved] = await as(db, alice, async () =>
            rows(db, 'select * from public.reschedule_my_booking($1, $2)', [b.id, await at(monday, '16:00')]),
        );
        const [row] = await rows(db, 'select customer_note from public.bookings where id = $1', [moved.id]);
        assert.equal(row.customer_note, 'السلام عليكم');
    });

    test('a later price change never changes a payment already made', async () => {
        const [b] = await as(db, alice, async () =>
            rows(db, 'select * from public.book_appointment($1, $2)', [fade, await at(monday, '17:00')]),
        );
        await as(db, zeyd, () => db.query("select * from public.staff_record_payment($1, 1500, 'cash')", [b.id]));
        await as(db, zeyd, () => db.query('update public.services set price = 18 where id = $1', [fade]));
        const [p] = await rows(
            db,
            "select amount_cents from public.payments where booking_id = $1 and status = 'paid'",
            [b.id],
        );
        assert.equal(p.amount_cents, 1500);
        const [a] = await rows(
            db,
            'select pa.zeyd_cents, pa.mother_cents from public.payment_allocations pa join public.payments p on p.id = pa.payment_id where p.booking_id = $1',
            [b.id],
        );
        assert.deepEqual([a.zeyd_cents, a.mother_cents], [1000, 500]);
    });
});
