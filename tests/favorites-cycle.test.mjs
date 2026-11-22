// Favourites of the bottom bar, end to end on PGlite with test data: the same statements as api.js
// (likeHaircut: insert haircut_id; unlikeHaircut: delete by haircut_id) and the list the sheet shows
// (gallery_with_likes().liked_by_me). Run with: npm test
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { as, createDb, rows, signUp } from './helpers.mjs';

describe('favourites: add, show, remove', () => {
    let db;
    let alice;
    let bob;
    let fade;
    let classic;

    const like = (who, id) =>
        as(db, who, () => db.query('insert into public.haircut_likes (haircut_id) values ($1)', [id]));
    const unlike = (who, id) =>
        as(db, who, () => db.query('delete from public.haircut_likes where haircut_id = $1', [id]));
    const favourites = async (who) =>
        (await as(db, who, () => rows(db, 'select id from public.gallery_with_likes() where liked_by_me'))).map(
            (r) => r.id,
        );

    before(async () => {
        db = await createDb();
        alice = await signUp(db, 'alice@example.test');
        bob = await signUp(db, 'bob@example.test');
        const add = async (url) =>
            (
                await rows(
                    db,
                    "insert into public.haircuts (image_url, title_fr, is_published) values ($1, 'Test', true) returning id",
                    [url],
                )
            )[0].id;
        fade = await add('gallery/test-fade.jpg');
        classic = await add('gallery/test-classic.jpg');
    });

    after(() => db.close());

    test('nothing in favourites at first', async () => {
        assert.deepEqual(await favourites(alice), []);
    });

    test('adding a photo shows it in the customer favourites only', async () => {
        await like(alice, fade);
        assert.deepEqual(await favourites(alice), [fade]);
        assert.deepEqual(await favourites(bob), [], 'another customer is not affected');
        assert.deepEqual(await favourites('anon'), []);
    });

    test('adding the same photo twice keeps one favourite (the site treats 23505 as success)', async () => {
        await assert.rejects(like(alice, fade), (error) => error.code === '23505');
        assert.deepEqual(await favourites(alice), [fade]);
    });

    test('removing it empties the favourites again; removing twice is harmless', async () => {
        await like(alice, classic);
        await unlike(alice, fade);
        assert.deepEqual(await favourites(alice), [classic]);
        await unlike(alice, fade);
        await unlike(alice, classic);
        assert.deepEqual(await favourites(alice), []);
    });

    test("a customer's removal never touches another customer's favourite", async () => {
        await like(bob, fade);
        await unlike(alice, fade);
        assert.deepEqual(await favourites(bob), [fade]);
    });
});
