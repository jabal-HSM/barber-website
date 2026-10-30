// Custom times ("I'll come at 16:20"): same rules as normal slots except the 15-minute grid.
// The key rule: a time less than one cut (35 min) away from another booking is refused.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { as, createDb, rows, signUp } from './helpers.mjs';

const TZ = 'Europe/Paris';

async function serviceId(db, slug) {
    return (await rows(db, 'select id from public.services where slug = $1', [slug]))[0].id;
}

async function nextMonday(db) {
    const [row] = await rows(
        db,
        `select day::text from public.bookable_days()
         where extract(isodow from day) = 1 and day >= (now() at time zone '${TZ}')::date + 2 order by day limit 1`,
    );
    return row.day;
}

async function at(db, day, hhmi) {
    return (await rows(db, `select ($1::date + $2::time) at time zone '${TZ}' as ts`, [day, hhmi]))[0].ts;
}

const custom = (db, service, startsAt) =>
    db.query('select * from public.request_custom_time($1, $2)', [service, startsAt]).then((r) => r.rows[0]);
const book = (db, service, startsAt) =>
    db.query('select * from public.book_appointment($1, $2)', [service, startsAt]).then((r) => r.rows[0]);

describe('custom times', () => {
    let db;
    let users;
    let admin;
    let fade; // 35 min
    let kids; // duration unknown
    let monday;
    let tuesday;

    before(async () => {
        db = await createDb();
        users = [];
        for (const name of ['u1', 'u2', 'u3', 'u4', 'u5', 'u6']) users.push(await signUp(db, `${name}@example.test`));
        admin = await signUp(db, 'admin@example.test');
        await db.query("update public.profiles set role = 'admin' where id = $1", [admin]);
        fade = await serviceId(db, 'degrade-bas');
        kids = await serviceId(db, 'coupe-enfant');
        monday = await nextMonday(db);
        tuesday = (await rows(db, 'select ($1::date + 1)::text as d', [monday]))[0].d;
    });

    after(() => db.close());

    test('Monday 16:00 booked: 16:15 is refused as too close; 15:40 too; 16:35 and 15:25 are accepted', async () => {
        const [u1, u2, u3, u4] = users;
        await as(db, u1, async () => book(db, fade, await at(db, monday, '16:00')));

        await as(db, u2, async () => {
            await assert.rejects(custom(db, fade, await at(db, monday, '16:15')), /too_close/);
            await assert.rejects(custom(db, fade, await at(db, monday, '15:40')), /too_close/, 'ends 16:15, overlaps');
            await assert.rejects(custom(db, fade, await at(db, monday, '16:34')), /too_close/, '34 minutes later');
            const later = await custom(db, fade, await at(db, monday, '16:35'));
            assert.equal(later.status, 'confirmed', 'exactly 35 minutes later is fine');
        });
        await as(db, u3, async () => {
            const earlier = await custom(db, fade, await at(db, monday, '15:25'));
            assert.equal(earlier.status, 'confirmed', 'ends exactly at 16:00');
        });
        // The normal slots see the custom bookings too
        const slots = await as(db, u4, () =>
            rows(
                db,
                `select to_char(starts_at at time zone '${TZ}', 'HH24:MI') as t from public.available_slots($1, $2)`,
                [fade, monday],
            ),
        );
        const times = slots.map((s) => s.t);
        for (const taken of ['15:00', '15:15', '15:30', '15:45', '16:00', '16:15', '16:30', '16:45', '17:00']) {
            assert.ok(!times.includes(taken), taken);
        }
        assert.ok(times.includes('14:45') && times.includes('17:15'));
    });

    test('custom times outside opening hours are refused: break, after closing, closed day', async () => {
        await as(db, users[4], async () => {
            for (const [day, hhmi] of [
                [monday, '12:30'], // break
                [monday, '11:40'], // would end 12:15, inside the break
                [monday, '18:40'], // would end after 19:00
                [monday, '08:30'], // before opening
                [tuesday, '10:00'], // closed day
            ]) {
                await assert.rejects(custom(db, fade, await at(db, day, hhmi)), /outside_hours/, `${day} ${hhmi}`);
            }
            await assert.rejects(custom(db, fade, '2020-01-06T09:00:00Z'), /invalid_time/);
        });
    });

    test('an off-grid time inside opening hours is confirmed at once', async () => {
        const result = await as(db, users[4], async () => custom(db, fade, await at(db, monday, '10:20')));
        assert.equal(result.status, 'confirmed');
    });

    test('unknown duration: stays requested but holds the chair for 35 minutes', async () => {
        const request = await as(db, users[5], async () => custom(db, kids, await at(db, monday, '17:30')));
        assert.equal(request.status, 'requested');
        await as(db, users[4], async () => {
            await assert.rejects(custom(db, fade, await at(db, monday, '17:45')), /too_close|too_many/);
        });
        const slots = await rows(
            db,
            `select to_char(starts_at at time zone '${TZ}', 'HH24:MI') as t from public.available_slots($1, $2)`,
            [fade, monday],
        );
        assert.ok(!slots.some((s) => s.t === '17:30' || s.t === '17:45'));
        // The database itself refuses an overlap with a requested booking
        await assert.rejects(
            db.query(
                "insert into public.bookings (customer_id, service_id, starts_at, ends_at, status) values ($1, $2, $3, $3::timestamptz + interval '35 minutes', 'confirmed')",
                [users[0], fade, await at(db, monday, '17:40')],
            ),
            /bookings_no_overlap/,
        );
        await as(db, admin, async () => {
            await db.query("select public.set_booking_status($1, 'confirmed')", [request.id]);
        });
    });

    test('staff can cancel with a reason and get what is needed to write to the customer', async () => {
        const [booking] = await rows(
            db,
            `select id from public.bookings where customer_id = $1 and status = 'confirmed' order by starts_at limit 1`,
            [users[0]],
        );
        await as(db, users[1], async () => {
            await assert.rejects(
                db.query('select * from public.staff_cancel_booking($1, $2)', [booking.id, 'x']),
                /forbidden/,
            );
        });
        const [info] = await as(db, admin, () =>
            rows(db, 'select * from public.staff_cancel_booking($1, $2)', [booking.id, '  Rendez-vous médical  ']),
        );
        assert.equal(info.customer_email, 'u1@example.test');
        assert.equal(info.service_name_fr, 'Dégradé bas');
        const [stored] = await rows(
            db,
            'select status, cancel_reason, cancelled_by from public.bookings where id = $1',
            [booking.id],
        );
        assert.deepEqual(stored, { status: 'cancelled', cancel_reason: 'Rendez-vous médical', cancelled_by: admin });
        // 16:00 is free again
        const free = await as(db, users[1], async () => custom(db, fade, await at(db, monday, '16:00')));
        assert.equal(free.status, 'confirmed');
    });

    test('online booking can be switched off by staff (holidays)', async () => {
        await as(db, admin, () => db.query('update public.booking_settings set booking_enabled = false'));
        assert.equal((await rows(db, 'select * from public.bookable_days()')).length, 0);
        await as(db, users[2], async () => {
            await assert.rejects(custom(db, fade, await at(db, monday, '09:00')), /booking_disabled/);
        });
        await as(db, admin, () => db.query('update public.booking_settings set booking_enabled = true'));
    });

    test('internal helpers are not callable through the API', async () => {
        await as(db, users[2], async () => {
            await assert.rejects(
                db.query('select public.chair_is_taken(now(), now())'),
                /permission denied for function/,
            );
            await assert.rejects(
                db.query('select public.fits_opening_hours(now(), now())'),
                /permission denied for function/,
            );
        });
    });
});
