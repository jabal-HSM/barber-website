// Booking times shown as free (green) or taken (grey « Réservé »), with 30-minute services every 30 minutes,
// Monday/Friday/Saturday only. Grid logic: Zeyd/slotGrid.js. Rules: PGlite against the real migrations
// (not the real Supabase project). Run with: npm test
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { buildSlotGrid, isoWeekday } from '../Zeyd/slotGrid.js';
import { parisLocalToIso } from '../Zeyd/time.js';
import { as, createDb, rows, signUp } from './helpers.mjs';

const TZ = 'Europe/Paris';
const HOURS = [1, 5, 6].flatMap((weekday) => [
    { weekday, opens_at: '09:00:00', closes_at: '12:00:00' },
    { weekday, opens_at: '14:00:00', closes_at: '19:00:00' },
]);
const ALL_STARTS = [
    '09:00',
    '09:30',
    '10:00',
    '10:30',
    '11:00',
    '11:30',
    '14:00',
    '14:30',
    '15:00',
    '15:30',
    '16:00',
    '16:30',
    '17:00',
    '17:30',
    '18:00',
    '18:30',
];
const parisTime = (iso) =>
    new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

const grid = (day, freeTimes, overrides = {}) =>
    buildSlotGrid({
        day,
        hours: HOURS,
        stepMinutes: 30,
        durationMinutes: 30,
        minNoticeMinutes: 60,
        now: Date.parse('2026-01-01T00:00:00Z'),
        freeSlots: freeTimes.map((t) => ({ starts_at: parisLocalToIso(`${day}T${t}`) })),
        toIso: parisLocalToIso,
        ...overrides,
    });

describe('slot grid (Zeyd/slotGrid.js)', () => {
    test('ISO weekday of a day', () => {
        assert.deepEqual(
            ['2026-11-02', '2026-11-03', '2026-11-06', '2026-11-07', '2026-11-08'].map(isoWeekday),
            [1, 2, 5, 6, 7],
        );
    });

    test('every start every 30 minutes, 09:00–11:30 and 14:00–18:30; all free when nothing is booked', () => {
        const slots = grid('2026-11-02', ALL_STARTS);
        assert.deepEqual(
            slots.map((s) => parisTime(s.starts_at)),
            ALL_STARTS,
        );
        assert.ok(slots.every((s) => !s.taken));
    });

    test('a start the database does not return as free is taken, and carries only its time', () => {
        const slots = grid(
            '2026-11-02',
            ALL_STARTS.filter((t) => t !== '09:00'),
        );
        const nine = slots.find((s) => parisTime(s.starts_at) === '09:00');
        assert.deepEqual(Object.keys(nine).sort(), ['starts_at', 'taken']);
        assert.equal(nine.taken, true);
        assert.equal(slots.filter((s) => s.taken).length, 1);
    });

    test('Tuesday, Wednesday, Thursday and Sunday have no times at all', () => {
        for (const day of ['2026-11-03', '2026-11-04', '2026-11-05', '2026-11-08']) {
            assert.deepEqual(grid(day, []), [], day);
        }
    });

    test('times inside the notice period are not shown (neither free nor taken)', () => {
        const now = Date.parse(parisLocalToIso('2026-11-02T09:10'));
        const slots = grid('2026-11-02', [], { now });
        assert.equal(parisTime(slots[0].starts_at), '10:30', 'first start at least 60 minutes ahead');
    });

    test('no grid without a duration or a step: only the free times are listed', () => {
        assert.deepEqual(grid('2026-11-02', ['09:00'], { durationMinutes: null }).length, 1);
        assert.deepEqual(grid('2026-11-02', ['09:00'], { stepMinutes: 0 }).length, 1);
    });
});

describe('30-minute services, Monday/Friday/Saturday (PGlite)', () => {
    let db;
    let alice;
    let bob;
    let fade;
    let monday;
    let friday;
    let tuesday;
    let hours;

    const freeTimes = async (who, day) =>
        (
            await as(db, who, () =>
                rows(
                    db,
                    `select to_char(starts_at at time zone '${TZ}', 'HH24:MI') as t, starts_at
                     from public.available_slots($1, $2) order by starts_at`,
                    [fade, day],
                ),
            )
        ).map((r) => r.t);
    const at = async (day, hhmi) =>
        (await rows(db, `select ($1::date + $2::time) at time zone '${TZ}' as ts`, [day, hhmi]))[0].ts;
    const book = (who, day, hhmi) =>
        as(db, who, async () =>
            rows(db, 'select * from public.book_appointment($1, $2, null)', [fade, await at(day, hhmi)]),
        );
    // What the site shows to a visitor: the grid built from the database answers
    const shown = async (day) => {
        const free = await as(db, 'anon', () =>
            rows(db, 'select starts_at from public.available_slots($1, $2)', [fade, day]),
        );
        return Object.fromEntries(
            buildSlotGrid({
                day,
                hours,
                stepMinutes: 30,
                durationMinutes: 30,
                minNoticeMinutes: 60,
                now: Date.now(),
                freeSlots: free.map((r) => ({ starts_at: new Date(r.starts_at).toISOString() })),
                toIso: parisLocalToIso,
            }).map((s) => [parisTime(s.starts_at), s.taken ? 'Réservé' : 'libre']),
        );
    };

    before(async () => {
        db = await createDb();
        alice = await signUp(db, 'alice@example.test');
        bob = await signUp(db, 'bob@example.test');
        // The values the owner sets in the dashboard: 30-minute step, 30-minute services
        await db.query('update public.booking_settings set slot_step_minutes = 30, max_active_bookings = 10');
        await db.query('update public.services set duration_minutes = 30 where duration_minutes = 35');
        fade = (await rows(db, "select id from public.services where slug = 'degrade-bas'"))[0].id;
        const nextDay = async (isodow) =>
            (
                await rows(
                    db,
                    `select d::date::text as day from generate_series((now() at time zone '${TZ}')::date + 2,
                     (now() at time zone '${TZ}')::date + 9, interval '1 day') d where extract(isodow from d) = $1`,
                    [isodow],
                )
            )[0].day;
        [monday, friday, tuesday] = [await nextDay(1), await nextDay(5), await nextDay(2)];
        hours = (
            await rows(
                db,
                "select weekday, to_char(opens_at, 'HH24:MI:SS') as opens_at, to_char(closes_at, 'HH24:MI:SS') as closes_at from public.business_hours",
            )
        ).map((h) => ({ ...h, weekday: Number(h.weekday) }));
    });

    after(() => db.close());

    test('prices are unchanged and the two services without a duration stay without one', async () => {
        const services = await rows(
            db,
            'select slug, duration_minutes, price::text from public.services order by slug',
        );
        const bySlug = Object.fromEntries(services.map((s) => [s.slug, s]));
        assert.equal(bySlug['coupe-enfant'].duration_minutes, null);
        assert.equal(bySlug['coupe-et-barbe'].duration_minutes, null);
        assert.equal(services.filter((s) => s.duration_minutes === 30).length, 6);
    });

    test('only Monday, Friday and Saturday can be chosen', async () => {
        const days = await rows(db, 'select distinct extract(isodow from day)::int as d from public.bookable_days()');
        assert.deepEqual(days.map((r) => r.d).sort(), [1, 5, 6]);
    });

    test('the database refuses a booking on another day, even sent directly', async () => {
        assert.deepEqual(await freeTimes(alice, tuesday), []);
        await assert.rejects(book(alice, tuesday, '09:00'));
        const [{ n }] = await rows(db, 'select count(*)::int as n from public.bookings');
        assert.equal(n, 0);
    });

    test('Monday offers 09:00 to 11:30 and 14:00 to 18:30, every 30 minutes', async () => {
        assert.deepEqual(await freeTimes(bob, monday), ALL_STARTS);
    });

    test('Monday 09:00 booked: grey « Réservé » for everyone else, 09:30 stays free, Friday 09:00 stays free', async () => {
        await book(alice, monday, '09:00');
        assert.ok(!(await freeTimes(bob, monday)).includes('09:00'));
        assert.ok((await freeTimes(bob, monday)).includes('09:30'));
        assert.ok((await freeTimes(bob, friday)).includes('09:00'));
        const mondayShown = await shown(monday);
        assert.equal(mondayShown['09:00'], 'Réservé');
        assert.equal(mondayShown['09:30'], 'libre');
        assert.equal((await shown(friday))['09:00'], 'libre');
    });

    test('nobody else can take Monday 09:00, and the database blocks two overlapping bookings', async () => {
        await assert.rejects(book(bob, monday, '09:00'), /slot_unavailable/);
        const start = await at(monday, '10:00');
        await db.query(
            `insert into public.bookings (customer_id, service_id, starts_at, ends_at, status)
             values ($1, $2, $3, $3::timestamptz + interval '30 minutes', 'confirmed')`,
            [bob, fade, start],
        );
        await assert.rejects(
            db.query(
                `insert into public.bookings (customer_id, service_id, starts_at, ends_at, status)
                 values ($1, $2, $3, $3::timestamptz + interval '30 minutes', 'confirmed')`,
                [alice, fade, start],
            ),
            /bookings_no_overlap/,
        );
        await db.query('delete from public.bookings where customer_id = $1 and starts_at = $2', [bob, start]);
    });

    test('after the cancellation Monday 09:00 is free (green) again for everyone', async () => {
        const [{ id }] = await rows(
            db,
            "select id from public.bookings where customer_id = $1 and status = 'confirmed'",
            [alice],
        );
        await as(db, alice, () => rows(db, "select * from public.cancel_my_booking($1, 'unavailable')", [id]));
        assert.ok((await freeTimes(bob, monday)).includes('09:00'));
        assert.equal((await shown(monday))['09:00'], 'libre');
    });
});
