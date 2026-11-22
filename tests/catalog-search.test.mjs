// Search of the bottom bar (Zeyd/catalogSearch.js) and the geometry of the floating notch (Zeyd/notchGeometry.js).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { normalize, searchCatalog } from '../Zeyd/catalogSearch.js';
import { barPath, easeInOutCubic, edgePath, NOTCH } from '../Zeyd/notchGeometry.js';

const services = [
    {
        id: 'degrade-bas',
        name: { fr: 'Dégradé bas', ar: 'تدرّج منخفض' },
        description: { fr: 'Dégradé court, près de la nuque', ar: 'تدرّج قصير قرب الرقبة' },
    },
    {
        id: 'coupe-et-barbe',
        name: { fr: 'Coupe et barbe', ar: 'قصّة ولحية' },
        description: { fr: 'Coupe de cheveux et taille de barbe', ar: 'قصّ الشعر وتهذيب اللحية' },
    },
];
const gallery = [{ id: 'p1', alt: { fr: 'Dégradé américain', ar: 'تدرّج أمريكي' }, category: 'fade' }];

describe('catalog search', () => {
    test('accents, case and Arabic marks are ignored', () => {
        assert.equal(normalize('DÉGRADÉ'), 'degrade');
        assert.equal(normalize('قصّة'), 'قصه');
        assert.equal(normalize('  إلى   أعلى '), 'الي اعلي');
    });

    test('French and Arabic queries find the real services and photos', () => {
        assert.deepEqual(
            searchCatalog('degrade', { services, gallery }).services.map((s) => s.id),
            ['degrade-bas'],
        );
        assert.deepEqual(
            searchCatalog('degrade', { services, gallery }).photos.map((p) => p.id),
            ['p1'],
        );
        assert.deepEqual(
            searchCatalog('لحية', { services, gallery }).services.map((s) => s.id),
            ['coupe-et-barbe'],
        );
        assert.deepEqual(
            searchCatalog('قصة', { services, gallery }).services.map((s) => s.id),
            ['coupe-et-barbe'],
            'with or without the shadda',
        );
    });

    test('every word must match; nothing is returned for a very short or unknown query', () => {
        assert.deepEqual(searchCatalog('coupe barbe', { services, gallery }).services.length, 1);
        assert.deepEqual(searchCatalog('coupe ciseaux', { services, gallery }).services.length, 0);
        assert.deepEqual(searchCatalog('d', { services, gallery }), { services: [], photos: [] });
        assert.deepEqual(searchCatalog('xyz', { services, gallery }), { services: [], photos: [] });
    });

    test('an empty gallery gives no photo result (no invented photo)', () => {
        assert.deepEqual(searchCatalog('degrade', { services, gallery: [] }).photos, []);
    });
});

describe('floating notch geometry', () => {
    const numbers = (path) => path.match(/-?\d+(\.\d+)?/g).map(Number);

    test('the bump peaks above the active tab and the panel goes down to the bottom', () => {
        const d = barPath(360, 100, 180);
        assert.match(d, /^M0 /);
        assert.ok(d.includes(' 180 0'), 'top of the bump at the centre');
        assert.ok(d.includes('L360 100'), 'down to the bottom right');
        assert.ok(d.endsWith('Z'));
    });

    test('at the first and last tab the bump stays inside the panel and clear of the corners', () => {
        for (const cx of [36, 324]) {
            const values = numbers(edgePath(360, cx));
            assert.ok(
                values.every((n) => n >= 0 && n <= 360),
                `inside for cx=${cx}`,
            );
        }
        const firstFoot = numbers(edgePath(360, 36))[6];
        assert.ok(firstFoot >= NOTCH.radius, 'left foot after the corner');
    });

    test('the easing goes from 0 to 1 without overshoot', () => {
        assert.equal(easeInOutCubic(0), 0);
        assert.equal(easeInOutCubic(1), 1);
        for (let t = 0; t <= 1; t += 0.05) assert.ok(easeInOutCubic(t) >= 0 && easeInOutCubic(t) <= 1);
    });
});
