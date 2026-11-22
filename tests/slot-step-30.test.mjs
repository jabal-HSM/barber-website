// Start times every 30 minutes (booking_settings.slot_step_minutes = 30, the value now saved on zeyd-dev-1)
// with the current 35-minute services, on PGlite against the real migrations. Run with: npm test
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { as, createDb, rows, signUp } from './helpers.mjs';

const TZ = 'Europe/Paris';

const localStarts = async (db, service, day) =>
    (
        await rows(
            db,
            `select to_char(starts_at at time zone '${TZ}', 'HH24:MI') as t from public.available_slots($1, $2)
             order by starts_at`,
            [service, day],
        )
    ).map((r) => r.t);

const at = async (db, day, hhmi) =>
    (await rows(db, `select ($1::date + $2::time) at time zone '${TZ}' as ts`, [day, hhmi]))[0].ts;

const book = (db, service, startsAt) =>
    rows(db, 'select * from public.book_appointment($1, $2, null)', [service, startsAt]);

describe('start times every 30 minutes', () => {
    let db;
    let alice;
    let bob;
    let fade; // 35 min
    let monday;

    before(async () => {
        db = await createDb();
        alice = await signUp(db, 'alice@example.test');
        bob = await signUp(db, 'bob@example.test');
        await db.query('update public.booking_settings set slot_step_minutes = 30');
        fade = (await rows(db, "select id from public.services where slug = 'degrade-bas'"))[0].id;
        [{ day: monday }] = await rows(
            db,
            `select day::text from public.bookable_days()
             where extract(isodow from day) = 1 and day >= (now() at time zone '${TZ}')::date + 2
             order by day limit 1`,
        );
    });

    after(() => db.close());

    test('starts are on the hour and the half hour; a 35-minute service must end before closing', async () => {
        assert.deepEqual(await localStarts(db, fade, monday), [
            '09:00',
            '09:30',
            '10:00',
            '10:30',
            '11:00', // 11:30 + 35 min would end at 12:05, after the 12:00 break
            '14:00',
            '14:30',
            '15:00',
            '15:30',
            '16:00',
            '16:30',
            '17:00',
            '17:30',
            '18:00', // 18:30 + 35 min would end at 19:05, after closing
        ]);
    });

    test('a booked time disappears for every other customer, with the next start it overlaps', async () => {
        await as(db, alice, async () => book(db, fade, await at(db, monday, '09:00')));
        const seenByBob = await as(db, bob, () => localStarts(db, fade, monday));
        const seenByVisitor = await as(db, 'anon', () => localStarts(db, fade, monday));
        for (const seen of [seenByBob, seenByVisitor]) {
            assert.ok(!seen.includes('09:00'), 'the booked start is gone');
            assert.ok(!seen.includes('09:30'), '09:30 would overlap 09:00–09:35 on the single chair');
            assert.equal(seen[0], '10:00');
        }
    });

    test('another customer cannot take the same or an overlapping start', async () => {
        await as(db, bob, async () => {
            await assert.rejects(book(db, fade, await at(db, monday, '09:00')), /slot_unavailable/);
            await assert.rejects(book(db, fade, await at(db, monday, '09:30')), /slot_unavailable/);
        });
        const [{ n }] = await rows(
            db,
            "select count(*)::int as n from public.bookings where status = 'confirmed' and customer_id = $1",
            [bob],
        );
        assert.equal(n, 0);
    });

    test('after a cancellation the time is offered again to everyone', async () => {
        const [{ id }] = await rows(db, 'select id from public.bookings where customer_id = $1', [alice]);
        await as(db, alice, () => rows(db, "select * from public.cancel_my_booking($1, 'unavailable')", [id]));
        const seenByBob = await as(db, bob, () => localStarts(db, fade, monday));
        assert.equal(seenByBob[0], '09:00');
        assert.ok(seenByBob.includes('09:30'));
    });
});
