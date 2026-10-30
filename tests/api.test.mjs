// Tests for Zeyd/api.js that need no network: row mapping, URL filtering, and the no-backend fallback.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchGallery, fetchServices, isSafeImageUrl, mapGalleryRow, mapServiceRow, signIn } from '../Zeyd/api.js';
import { BACKEND } from '../Zeyd/config.js';
import { SERVICES } from '../Zeyd/data.js';

test('a services row maps to the same shape as data.js', () => {
    const row = {
        id: 'c54f2128-5c8a-470f-91a6-c48515777b42',
        slug: 'coupe-enfant',
        name_fr: 'Coupe enfant',
        name_ar: 'قصّة للأطفال',
        description_fr: 'Coupe de cheveux pour les enfants.',
        description_ar: 'قصّة شعر مخصّصة للأطفال.',
        price: '10.00',
        duration_minutes: null,
    };
    const expected = SERVICES.find((s) => s.id === 'coupe-enfant');
    assert.deepEqual(mapServiceRow(row), expected);
});

test('missing Arabic text falls back to French, missing slug to the id', () => {
    const mapped = mapServiceRow({ id: 'abc', name_fr: 'Test', name_ar: '', price: 15, duration_minutes: 35 });
    assert.equal(mapped.id, 'abc');
    assert.equal(mapped.name.ar, 'Test');
    assert.equal(mapped.description.fr, '');
});

test('gallery rows map to GALLERY entries with like information', () => {
    const mapped = mapGalleryRow({
        id: 'x',
        image_url: 'gallery/a.jpg',
        title_fr: 'Dégradé bas',
        title_ar: null,
        category: 'degrade',
        like_count: '3',
        liked_by_me: true,
    });
    assert.deepEqual(mapped, {
        id: 'x',
        src: 'gallery/a.jpg',
        category: 'degrade',
        alt: { fr: 'Dégradé bas', ar: 'Dégradé bas' },
        likeCount: 3,
        likedByMe: true,
    });
});

test('only https or relative image URLs are accepted', () => {
    assert.ok(isSafeImageUrl('https://example.supabase.co/storage/v1/object/public/gallery/a.jpg'));
    assert.ok(isSafeImageUrl('gallery/a.jpg'));
    for (const bad of ['javascript:alert(1)', 'http://insecure.test/a.jpg', 'data:image/png;base64,xx', '', null]) {
        assert.ok(!isSafeImageUrl(bad), String(bad));
    }
});

// Only meaningful when config.js has BACKEND = null (the tests never call the real project).
test('without a configured backend, the site keeps its built-in content', {
    skip: BACKEND ? 'a backend is configured in config.js' : false,
}, async () => {
    assert.equal(await fetchServices(), null);
    assert.equal(await fetchGallery(), null);
    assert.ok((await signIn('a@example.test', 'x')).error);
});
