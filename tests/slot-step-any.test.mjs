// The gap between start times is chosen by the salon (dashboard → Réglages, 5 to 60 minutes): whatever the
// value, start times follow it from the opening time, a service always ends before the break or closing, and
// two bookings can never overlap, even by one minute. Run with: npm test
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { as, createDb, rows, signUp } from './helpers.mjs';

const TZ = 'Europe/Paris';
const minutes = (hhmi) => Number(hhmi.slice(0, 2)) * 60 + Number(hhmi.slice(3, 5));

describe('any gap between start times', () => {
    let db;
    let alice;
    let bob;
    let fade; // 35 min
    let monday;

    const starts = async (day) =>
        (
            await rows(
                db,
                `select to_char(starts_at at time zone '${TZ}', 'HH24:MI') as t from public.available_slots($1, $2)
                 order by starts_at`,
                [fade, day],
            )
        ).map((r) => r.t);
    const at = async (day, hhmi) =>
        (await rows(db, `select ($1::date + $2::time) at time zone '${TZ}' as ts`, [day, hhmi]))[0].ts;
    const book = async (who, day, hhmi) =>
        as(db, who, async () =>
            rows(db, 'select * from public.book_appointment($1, $2, null)', [fade, await at(day, hhmi)]),
        );
    const setStep = (n) => db.query('update public.booking_settings set slot_step_minutes = $1', [n]);

    before(async () => {
        db = await createDb();
        alice = await signUp(db, 'alice@example.test');
        bob = await signUp(db, 'bob@example.test');
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

    for (const step of [10, 25]) {
        test(`every ${step} minutes: starts follow the gap and a 35-minute cut fits before the break or closing`, async () => {
            await setStep(step);
            const list = await starts(monday);
            assert.ok(list.length > 0);
            for (const t of list) {
                const m = minutes(t);
                const opening = m < 12 * 60 ? 9 * 60 : 14 * 60;
                assert.equal((m - opening) % step, 0, `${t} is not on the ${step}-minute grid`);
                assert.ok(m + 35 <= (m < 12 * 60 ? 12 * 60 : 19 * 60), `${t} would run into the break or closing`);
            }
            assert.equal(list[0], '09:00');
        });
    }

    test('every 25 minutes: a booking at 09:00 removes 09:25 (it would overlap until 09:35), 09:50 stays free', async () => {
        await setStep(25);
        await book(alice, monday, '09:00');
        const list = await starts(monday);
        assert.ok(!list.includes('09:00') && !list.includes('09:25'));
        assert.ok(list.includes('09:50'));
        // Trying anyway gives a clear error, nothing is saved
        await assert.rejects(book(bob, monday, '09:25'), /slot_unavailable/);
        const [{ n }] = await rows(db, "select count(*)::int n from public.bookings where status = 'confirmed'");
        assert.equal(n, 1);
    });

    test('every 10 minutes: no overlap even by a few minutes, and a time off the grid is refused', async () => {
        await setStep(10);
        await book(alice, monday, '14:00'); // until 14:35
        for (const t of ['14:10', '14:20', '14:30']) await assert.rejects(book(bob, monday, t), /slot_unavailable/);
        await assert.rejects(book(bob, monday, '14:37'), /slot_unavailable/, 'not on the 10-minute grid');
        const [b] = await book(bob, monday, '14:40'); // right after: allowed
        assert.ok(b?.id);
    });

    test('the gap must stay between 5 and 60 minutes', async () => {
        await assert.rejects(setStep(3), /check/i);
        await assert.rejects(setStep(90), /check/i);
        await setStep(30); // the value the salon uses
        const [{ s }] = await rows(db, 'select slot_step_minutes s from public.booking_settings');
        assert.equal(s, 30);
    });
});
