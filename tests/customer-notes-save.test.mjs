// Saving Zeyd's private note about a customer, with the same statements the dashboard sends through
// PostgREST (Zeyd/admin.js saveCustomerNote), on PGlite against the real migrations. Run with: npm test
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { as, createDb, rows, signUp } from './helpers.mjs';

// supabase-js .update({ note }).eq('customer_id', id).select('customer_id')
const updateNote = (db, customer, note) =>
    rows(db, 'update public.customer_notes set note = $2 where customer_id = $1 returning customer_id', [
        customer,
        note,
    ]);
// supabase-js .insert({ customer_id, note }).select('customer_id')
const insertNote = (db, customer, note) =>
    rows(db, 'insert into public.customer_notes (customer_id, note) values ($1, $2) returning customer_id', [
        customer,
        note,
    ]);
const noteOf = async (db, customer) =>
    (await rows(db, 'select note, updated_by from public.customer_notes where customer_id = $1', [customer]))[0];

describe('customer notes saved from the dashboard', () => {
    let db;
    let alice;
    let bob;
    let zeyd;

    before(async () => {
        db = await createDb();
        alice = await signUp(db, 'alice@example.test');
        bob = await signUp(db, 'bob@example.test');
        zeyd = await signUp(db, 'zeyd@example.test');
        await db.query("update public.profiles set role = 'admin' where id = $1", [zeyd]);
    });

    after(() => db.close());

    test('the former upsert is refused: it also sets customer_id, which staff may not update', async () => {
        await as(db, zeyd, async () => {
            await assert.rejects(
                db.query(
                    `insert into public.customer_notes (customer_id, note) values ($1, 'x')
                     on conflict (customer_id) do update set customer_id = excluded.customer_id, note = excluded.note`,
                    [alice],
                ),
                /permission denied for table customer_notes/,
            );
        });
        assert.equal(await noteOf(db, alice), undefined, 'nothing was written');
    });

    test('first save: no row to update, so the note is inserted and returned', async () => {
        await as(db, zeyd, async () => {
            assert.equal((await updateNote(db, alice, 'Préfère les ciseaux')).length, 0);
            assert.deepEqual(await insertNote(db, alice, 'Préfère les ciseaux'), [{ customer_id: alice }]);
        });
        assert.deepEqual(await noteOf(db, alice), { note: 'Préfère les ciseaux', updated_by: zeyd });
    });

    test('next saves update the same row, for the right customer only', async () => {
        await as(db, zeyd, async () => {
            await insertNote(db, bob, 'Note de Bob');
            assert.deepEqual(await updateNote(db, alice, 'Dégradé bas, 3 mm'), [{ customer_id: alice }]);
        });
        assert.equal((await noteOf(db, alice)).note, 'Dégradé bas, 3 mm');
        assert.equal((await noteOf(db, bob)).note, 'Note de Bob');
        const [{ n }] = await rows(db, 'select count(*)::int as n from public.customer_notes where customer_id = $1', [
            alice,
        ]);
        assert.equal(n, 1);
    });

    test('the note stays private: the customer cannot read or write it', async () => {
        await as(db, alice, async () => {
            assert.equal((await rows(db, 'select * from public.customer_notes')).length, 0);
            assert.equal((await updateNote(db, alice, 'hack')).length, 0);
            await assert.rejects(insertNote(db, bob, 'hack'), /row-level security|permission denied/);
        });
        assert.equal((await noteOf(db, alice)).note, 'Dégradé bas, 3 mm');
    });

    test('the database keeps the 1000-character limit', async () => {
        await as(db, zeyd, async () => {
            await assert.rejects(updateNote(db, alice, 'a'.repeat(1001)), /check constraint|customer_notes_note_check/);
        });
    });
});
