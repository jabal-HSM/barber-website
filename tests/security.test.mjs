// Security boundaries after ALL migrations: which database functions each role can call, and that every
// staff function refuses a signed-in customer. A new function that is callable by mistake fails this test.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { as, createDb, rows, signUp } from './helpers.mjs';

// Callable without an account: public information only
const ANON_ALLOWED = ['available_slots', 'bookable_days', 'gallery_with_likes', 'is_admin', 'is_staff'];

// Callable by any signed-in user; the "staff" ones check the role inside and are tested below
const CUSTOMER_FUNCTIONS = [
    'book_appointment',
    'cancel_booking',
    'cancel_my_booking',
    'my_loyalty',
    'request_custom_time',
    'reschedule_my_booking',
];
const STAFF_FUNCTIONS = {
    allocation_summary: 'select * from public.allocation_summary()',
    barber_earnings: 'select * from public.barber_earnings()',
    bookings_outside_schedule: 'select * from public.bookings_outside_schedule()',
    loyalty_confirm_visit: "select * from public.loyalty_confirm_visit('x')",
    loyalty_history: "select * from public.loyalty_history('x')",
    loyalty_lookup: "select * from public.loyalty_lookup('x')",
    loyalty_redeem_reward: "select * from public.loyalty_redeem_reward('x')",
    loyalty_search: "select * from public.loyalty_search('alice')",
    payment_records: 'select * from public.payment_records()',
    set_booking_status: "select public.set_booking_status(gen_random_uuid(), 'completed')",
    set_user_role: "select public.set_user_role(gen_random_uuid(), 'admin')",
    staff_cancel_booking: 'select * from public.staff_cancel_booking(gen_random_uuid())',
    staff_mark_mother_transfer: 'select public.staff_mark_mother_transfer(gen_random_uuid())',
    staff_record_payment: "select * from public.staff_record_payment(gen_random_uuid(), 1500, 'cash')",
};

describe('who can call what', () => {
    let db;
    let customer;

    before(async () => {
        db = await createDb();
        customer = await signUp(db, 'customer@example.test');
    });

    after(() => db.close());

    const callable = async (role) =>
        (
            await rows(
                db,
                `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and has_function_privilege($1, p.oid, 'execute') order by 1`,
                [role],
            )
        ).map((r) => r.proname);

    test('visitors without an account can call only the public functions', async () => {
        assert.deepEqual(await callable('anon'), ANON_ALLOWED);
    });

    test('signed-in users can call only customer functions and role-checked staff functions', async () => {
        const expected = [...ANON_ALLOWED, ...CUSTOMER_FUNCTIONS, ...Object.keys(STAFF_FUNCTIONS)].sort();
        assert.deepEqual(await callable('authenticated'), expected);
    });

    test('every staff function refuses a signed-in customer', async () => {
        for (const [name, sql] of Object.entries(STAFF_FUNCTIONS)) {
            await as(db, customer, async () => {
                await assert.rejects(db.query(sql), /forbidden/, name);
            });
        }
    });

    test('a customer cannot make themselves staff, nor change a price, nor read other people', async () => {
        await signUp(db, 'other@example.test');
        await as(db, customer, async () => {
            await db.query("update public.profiles set role = 'admin' where id = $1", [customer]).catch(() => {});
            await db.query('update public.services set price = 0').catch(() => {});
            assert.equal((await rows(db, 'select * from public.profiles')).length, 1, 'own profile only');
            assert.equal((await rows(db, 'select * from public.bookings')).length, 0);
            assert.equal((await rows(db, 'select id, status from public.payments')).length, 0);
            await assert.rejects(db.query('select barber_share_cents from public.payments'), /permission denied/);
        });
        const [p] = await rows(db, 'select role from public.profiles where id = $1', [customer]);
        assert.equal(p.role, 'customer');
        const prices = await rows(db, 'select price from public.services where price = 0');
        assert.equal(prices.length, 0);
    });
});
