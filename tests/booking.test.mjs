// Phase 3 booking rules, run on PGlite against the real migrations. Run with: npm test
// Dates are computed from the real current date, so the tests stay valid over time.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { as, createDb, rows, signUp } from './helpers.mjs';

const TZ = 'Europe/Paris';

// Local salon time of a timestamptz column, e.g. '09:00'
const localTime = (column) => `to_char(${column} at time zone '${TZ}', 'HH24:MI')`;

async function serviceId(db, slug) {
    return (await rows(db, 'select id from public.services where slug = $1', [slug]))[0].id;
}

// Next open day with the given ISO weekday, at least 2 days ahead (clear of the notice period).
async function nextDay(db, isodow) {
    const [row] = await rows(
        db,
        `select day::text from public.bookable_days()
         where extract(isodow from day) = $1 and day >= (now() at time zone '${TZ}')::date + 2
         order by day limit 1`,
        [isodow],
    );
    return row.day;
}

async function slots(db, service, day) {
    return rows(
        db,
        `select starts_at, ${localTime('starts_at')} as local_start, ${localTime('ends_at')} as local_end
         from public.available_slots($1, $2) order by starts_at`,
        [service, day],
    );
}

// Timestamp of `HH:MI` on `day`, salon time
async function at(db, day, hhmi) {
    return (await rows(db, `select ($1::date + $2::time) at time zone '${TZ}' as ts`, [day, hhmi]))[0].ts;
}

const book = (db, service, startsAt, note = null) =>
    db.query('select * from public.book_appointment($1, $2, $3)', [service, startsAt, note]);

describe('booking system', () => {
    let db;
    let alice;
    let bob;
    let carol;
    let admin;
    let fade; // 35 min
    let kids; // duration unknown
    let monday;

    before(async () => {
        db = await createDb();
        alice = await signUp(db, 'alice@example.test');
        bob = await signUp(db, 'bob@example.test');
        carol = await signUp(db, 'carol@example.test');
        admin = await signUp(db, 'admin@example.test');
        await db.query("update public.profiles set role = 'admin' where id = $1", [admin]);
        fade = await serviceId(db, 'degrade-bas');
        kids = await serviceId(db, 'coupe-enfant');
        monday = await nextDay(db, 1);
    });

    after(() => db.close());

    test('opening days are Monday, Friday and Saturday only', async () => {
        const days = await rows(
            db,
            'select distinct extract(isodow from day)::int as d from public.bookable_days() order by d',
        );
        assert.deepEqual(
            days.map((r) => r.d),
            [1, 5, 6],
        );
    });

    test('slots follow the hours, the 12:00–14:00 break and a 15-minute grid', async () => {
        const list = await as(db, 'anon', () => slots(db, fade, monday));
        const starts = list.map((s) => s.local_start);
        assert.equal(starts[0], '09:00');
        assert.equal(starts.at(-1), '18:15', 'last 35-minute slot that ends before 19:00');
        assert.ok(starts.includes('11:15') && !starts.includes('11:30'), 'morning ends before 12:00');
        assert.ok(!starts.some((t) => t >= '11:30' && t < '14:00'), 'no slot during the break');
        assert.ok(starts.includes('14:00'));
        assert.equal(list.length, 10 + 18);
        assert.ok(list.every((s) => s.local_end <= '19:00'));
    });

    test('every open day of the coming year starts at 09:00 Paris time, across daylight saving changes', async () => {
        await db.exec('update public.booking_settings set max_days_ahead = 365');
        try {
            const days = await rows(
                db,
                `select day::text from public.bookable_days() where day >= (now() at time zone '${TZ}')::date + 1`,
            );
            assert.ok(days.length > 100);
            const offsets = new Set();
            for (const { day } of days) {
                const [first] = await slots(db, fade, day);
                assert.equal(first.local_start, '09:00', day);
                offsets.add(new Date(first.starts_at).getUTCHours());
            }
            assert.deepEqual([...offsets].sort(), [7, 8], 'summer (UTC+2) and winter (UTC+1) both covered');
        } finally {
            await db.exec('update public.booking_settings set max_days_ahead = 30');
        }
    });

    test('no slots on closed days, closures, past days, beyond 30 days, or for unknown durations', async () => {
        const tuesday = (await rows(db, `select ($1::date + 1)::text as d`, [monday]))[0].d;
        assert.equal((await slots(db, fade, tuesday)).length, 0);
        assert.equal((await slots(db, fade, '2020-01-06')).length, 0);
        const far = (await rows(db, `select ((now() at time zone '${TZ}')::date + 60)::text as d`))[0].d;
        assert.equal((await slots(db, fade, far)).length, 0);
        assert.equal((await slots(db, kids, monday)).length, 0);

        await db.query("insert into public.closures (starts_on, ends_on, reason) values ($1, $1, 'test')", [monday]);
        assert.equal((await slots(db, fade, monday)).length, 0);
        assert.ok(!(await rows(db, 'select day::text from public.bookable_days()')).some((r) => r.day === monday));
        await db.exec('delete from public.closures');
    });

    test('visitors without an account cannot book or read bookings', async () => {
        const nine = await at(db, monday, '09:00');
        await as(db, 'anon', async () => {
            await assert.rejects(book(db, fade, nine), /permission denied for function/);
            await assert.rejects(db.query('select * from public.bookings'), /permission denied/);
        });
    });

    test('a customer books a free slot: confirmed at once, and the slot disappears', async () => {
        const nine = await at(db, monday, '09:00');
        const [result] = await as(db, alice, async () => (await book(db, fade, nine, '  Court sur les côtés  ')).rows);
        assert.equal(result.status, 'confirmed');
        const [stored] = await rows(db, `select ${localTime('ends_at')} as e, customer_note from public.bookings`);
        assert.deepEqual(stored, { e: '09:35', customer_note: 'Court sur les côtés' });

        const starts = (await slots(db, fade, monday)).map((s) => s.local_start);
        assert.ok(!starts.includes('09:00') && !starts.includes('09:15') && !starts.includes('09:30'));
        assert.ok(starts.includes('09:45'), 'next free start after 09:35');
    });

    test('double booking is impossible: same slot, overlapping slot, off-grid time, or during the break', async () => {
        await as(db, bob, async () => {
            for (const hhmi of ['09:00', '09:15', '09:05', '12:30', '08:00', '18:45']) {
                await assert.rejects(book(db, fade, await at(db, monday, hhmi)), /slot_unavailable/, hhmi);
            }
        });
    });

    test('the database itself rejects overlapping confirmed bookings (two clicks at the same moment)', async () => {
        const start = await at(db, monday, '16:00');
        await db.query(
            "insert into public.bookings (customer_id, service_id, starts_at, ends_at, status) values ($1, $2, $3, $3::timestamptz + interval '35 minutes', 'confirmed')",
            [bob, fade, start],
        );
        await assert.rejects(
            db.query(
                "insert into public.bookings (customer_id, service_id, starts_at, ends_at, status) values ($1, $2, $3::timestamptz + interval '10 minutes', $3::timestamptz + interval '45 minutes', 'confirmed')",
                [carol, fade, start],
            ),
            /bookings_no_overlap/,
        );
        await db.query('delete from public.bookings where customer_id = $1', [bob]);
    });

    test('customers cannot write bookings directly or see other customers', async () => {
        await as(db, bob, async () => {
            await assert.rejects(
                db.query(
                    'insert into public.bookings (customer_id, service_id, starts_at, ends_at) values ($1, $2, now(), now())',
                    [bob, fade],
                ),
                /permission denied/,
            );
            await assert.rejects(db.query("update public.bookings set status = 'cancelled'"), /permission denied/);
            assert.equal((await rows(db, 'select * from public.bookings')).length, 0, "Alice's booking is invisible");
        });
        await as(db, alice, async () => {
            assert.equal((await rows(db, 'select * from public.bookings')).length, 1);
        });
    });

    test('at most 2 upcoming bookings per customer', async () => {
        await as(db, alice, async () => {
            await book(db, fade, await at(db, monday, '10:00'));
            await assert.rejects(book(db, fade, await at(db, monday, '11:00')), /too_many_bookings/);
        });
    });

    test('cancelling: own booking only, not too late; staff can always cancel', async () => {
        const [mine] = await as(db, alice, () =>
            rows(db, `select id from public.bookings where ${localTime('starts_at')} = '10:00'`),
        );
        await as(db, bob, async () => {
            await assert.rejects(db.query('select public.cancel_booking($1)', [mine.id]), /not_found/);
        });
        await as(db, alice, async () => {
            await db.query('select public.cancel_booking($1)', [mine.id]);
            await assert.rejects(db.query('select public.cancel_booking($1)', [mine.id]), /invalid_status/);
        });
        assert.ok(
            (await slots(db, fade, monday)).some((s) => s.local_start === '10:00'),
            'slot is free again',
        );

        // A booking starting in 1 hour cannot be cancelled online by the customer (2-hour notice)…
        const [soon] = await rows(
            db,
            "insert into public.bookings (customer_id, service_id, starts_at, ends_at) values ($1, $2, now() + interval '1 hour', now() + interval '95 minutes') returning id",
            [carol, fade],
        );
        await as(db, carol, async () => {
            await assert.rejects(db.query('select public.cancel_booking($1)', [soon.id]), /too_late_to_cancel/);
        });
        // …but the barber can.
        await as(db, admin, async () => {
            await db.query('select public.cancel_booking($1)', [soon.id]);
        });
    });

    test('custom time request: does not block the chair until the barber confirms it', async () => {
        const tuesday = (await rows(db, `select ($1::date + 1)::text as d`, [monday]))[0].d;
        const [request] = await as(db, bob, async () =>
            rows(db, 'select * from public.request_custom_time($1, $2, $3)', [
                fade,
                await at(db, tuesday, '10:00'),
                'Seul jour possible',
            ]),
        );
        assert.equal(request.status, 'requested');

        const [overlapping] = await as(db, carol, async () =>
            rows(db, 'select * from public.request_custom_time($1, $2)', [kids, await at(db, monday, '09:10')]),
        );

        await as(db, bob, async () => {
            await assert.rejects(
                db.query("select public.set_booking_status($1, 'confirmed')", [request.id]),
                /forbidden/,
            );
        });
        await as(db, admin, async () => {
            await db.query("select public.set_booking_status($1, 'confirmed')", [request.id]);
            // Overlaps Alice's 09:00 booking and has no known duration
            await assert.rejects(
                db.query("select public.set_booking_status($1, 'confirmed', $2::timestamptz + interval '30 minutes')", [
                    overlapping.id,
                    await at(db, monday, '09:10'),
                ]),
                /slot_unavailable/,
            );
            await assert.rejects(
                db.query("select public.set_booking_status($1, 'confirmed')", [overlapping.id]),
                /invalid_time/,
            );
            // A visit cannot be marked completed before it starts
            await assert.rejects(
                db.query("select public.set_booking_status($1, 'completed')", [request.id]),
                /invalid_status/,
            );
        });
        const [stored] = await rows(db, 'select status, is_custom_request from public.bookings where id = $1', [
            request.id,
        ]);
        assert.deepEqual(stored, { status: 'confirmed', is_custom_request: true });

        await as(db, carol, async () => {
            await assert.rejects(
                db.query('select * from public.request_custom_time($1, $2)', [fade, '2020-01-01T10:00:00Z']),
                /invalid_time/,
            );
        });
    });

    test('anonymous visitors cannot change hours, closures or settings', async () => {
        await as(db, 'anon', async () => {
            await assert.rejects(db.query('delete from public.business_hours'), /permission denied/);
            await assert.rejects(
                db.query("insert into public.closures (starts_on, ends_on) values ('2030-01-01', '2030-01-02')"),
                /permission denied/,
            );
            await assert.rejects(
                db.query('update public.booking_settings set max_active_bookings = 99'),
                /permission denied/,
            );
        });
        await as(db, bob, async () => {
            const { affectedRows } = await db.query('update public.booking_settings set max_active_bookings = 99');
            assert.equal(affectedRows, 0);
            await assert.rejects(db.query('select public.check_can_book($1)', [bob]), /permission denied for function/);
        });
    });
});

describe('booking on the existing prototype tables', () => {
    let db;

    before(async () => {
        db = await createDb({ prototype: true });
    });

    after(() => db.close());

    test('old bookings columns become optional and booking works', async () => {
        const customer = await signUp(db, 'someone@example.test');
        const service = await serviceId(db, 'degrade-bas');
        const monday = await nextDay(db, 1);
        const [result] = await as(
            db,
            customer,
            async () => (await book(db, service, await at(db, monday, '14:00'))).rows,
        );
        assert.equal(result.status, 'confirmed');
        const policies = await rows(db, "select polname from pg_policy where polrelid = 'public.bookings'::regclass");
        assert.ok(!policies.some((p) => p.polname === 'insert own'), 'prototype insert policy removed');
    });
});
