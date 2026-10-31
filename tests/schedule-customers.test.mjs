// Phase 6 stage D: service and schedule validation in the database, bookings left outside a new schedule,
// private customer notes. Run with: npm test
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { as, createDb, rows, signUp } from './helpers.mjs';

const TZ = 'Europe/Paris';

describe('services, schedule and customer notes', () => {
    let db;
    let zeyd;
    let alice;
    let fade;

    before(async () => {
        db = await createDb();
        zeyd = await signUp(db, 'zeyd@example.test', { full_name: 'Zeyd' });
        alice = await signUp(db, 'alice@example.test', { full_name: 'Alice' });
        await db.query("update public.profiles set role = 'barber' where id = $1", [zeyd]);
        fade = (await rows(db, "select id from public.services where slug = 'degrade-bas'"))[0].id;
    });

    after(() => db.close());

    const updateService = (values) =>
        as(db, zeyd, () =>
            db.query('update public.services set price = $2, duration_minutes = $3, name_fr = $4 where id = $1', [
                fade,
                ...values,
            ]),
        );

    test('a service with an empty name, an absurd price or duration is refused by the database', async () => {
        await assert.rejects(updateService([15, 35, '   ']), /services_names_check/);
        await assert.rejects(updateService([-1, 35, 'Dégradé bas']), /services_price_check/);
        await assert.rejects(updateService([5000, 35, 'Dégradé bas']), /services_price_range_check/);
        await assert.rejects(updateService([15, 0, 'Dégradé bas']), /services_duration/);
        await assert.rejects(updateService([15, 37, 'Dégradé bas']), /services_duration_range_check/);
        await updateService([12, 40, 'Dégradé bas']); // valid change
        const [s] = await rows(db, 'select price, duration_minutes from public.services where id = $1', [fade]);
        assert.equal(Number(s.price), 12);
        assert.equal(s.duration_minutes, 40);
    });

    test('customers cannot change services, prices or hours', async () => {
        await as(db, alice, async () => {
            const r = await db.query('update public.services set price = 1 where id = $1', [fade]);
            assert.equal(r.affectedRows ?? 0, 0, 'RLS: nothing updated');
            await assert.rejects(
                db.query(
                    "insert into public.business_hours (weekday, opens_at, closes_at) values (2, '09:00', '10:00')",
                ),
                /row-level security|permission denied/,
            );
        });
        const [s] = await rows(db, 'select price from public.services where id = $1', [fade]);
        assert.notEqual(Number(s.price), 1);
    });

    test('two periods of the same day cannot overlap; touching periods are fine', async () => {
        await as(db, zeyd, async () => {
            await assert.rejects(
                db.query(
                    "insert into public.business_hours (weekday, opens_at, closes_at) values (1, '11:00', '15:00')",
                ),
                /hours_overlap/,
            );
            await assert.rejects(
                db.query(
                    "insert into public.business_hours (weekday, opens_at, closes_at) values (2, '18:00', '18:00')",
                ),
                /check/,
            );
            await db.query(
                "insert into public.business_hours (weekday, opens_at, closes_at) values (1, '12:00', '13:00')",
            );
            await db.query("delete from public.business_hours where weekday = 1 and opens_at = '12:00'");
        });
    });

    test('a closure added over a booked day keeps the booking and lists it for Zeyd', async () => {
        const [day] = await rows(
            db,
            `select day::text from public.bookable_days() where extract(isodow from day) = 1
             and day >= (now() at time zone '${TZ}')::date + 2 order by day limit 1`,
        );
        const ts = (await rows(db, `select ($1::date + time '10:00') at time zone '${TZ}' as ts`, [day.day]))[0].ts;
        const id = await as(
            db,
            alice,
            async () => (await rows(db, 'select * from public.book_appointment($1, $2)', [fade, ts]))[0].id,
        );
        assert.equal(
            (await as(db, zeyd, () => rows(db, 'select * from public.bookings_outside_schedule()'))).length,
            0,
        );

        await as(db, zeyd, () =>
            db.query("insert into public.closures (starts_on, ends_on, reason) values ($1, $1, 'Congés')", [day.day]),
        );
        const [b] = await rows(db, 'select status from public.bookings where id = $1', [id]);
        assert.equal(b.status, 'confirmed', 'never cancelled silently');
        const outside = await as(db, zeyd, () => rows(db, 'select * from public.bookings_outside_schedule()'));
        assert.deepEqual(
            outside.map((o) => o.id),
            [id],
        );
        assert.equal(outside[0].customer_name, 'Alice');

        await as(db, alice, async () => {
            await assert.rejects(db.query('select * from public.bookings_outside_schedule()'), /forbidden/);
        });
    });

    test('customer notes: staff only, the customer never sees them, author and time are recorded', async () => {
        await as(db, zeyd, () =>
            db.query("insert into public.customer_notes (customer_id, note) values ($1, 'Préfère les ciseaux')", [
                alice,
            ]),
        );
        const [n] = await rows(db, 'select note, updated_by from public.customer_notes where customer_id = $1', [
            alice,
        ]);
        assert.equal(n.note, 'Préfère les ciseaux');
        assert.equal(n.updated_by, zeyd);
        await as(db, alice, async () => {
            assert.equal((await rows(db, 'select * from public.customer_notes')).length, 0);
            await assert.rejects(
                db.query("insert into public.customer_notes (customer_id, note) values ($1, 'hack')", [alice]),
                /row-level security|permission denied/,
            );
        });
        await as(db, zeyd, async () => {
            await assert.rejects(
                db.query('update public.customer_notes set note = $2 where customer_id = $1', [
                    alice,
                    'x'.repeat(1001),
                ]),
                /check/,
            );
        });
    });
});
