// QR scanner of the dashboard: why the camera cannot be used (Zeyd/camera.js), the messages in both
// languages, and that reading a QR code never adds a visit by itself (PGlite). The real camera needs a
// browser and a device: these tests do not open one.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { at } from '../Zeyd/admin-i18n.js';
import { cameraErrorKey, cameraUnavailable } from '../Zeyd/camera.js';
import { as, createDb, rows, signUp } from './helpers.mjs';

const camera = { getUserMedia() {} };

describe('camera availability', () => {
    test('an http:// address on the network is not a secure page: the camera is not requested', () => {
        assert.equal(cameraUnavailable({ isSecureContext: false, mediaDevices: undefined }), 'loyalty.cameraInsecure');
        assert.equal(cameraUnavailable({ isSecureContext: false, mediaDevices: camera }), 'loyalty.cameraInsecure');
    });

    test('a secure page without camera support says so', () => {
        assert.equal(
            cameraUnavailable({ isSecureContext: true, mediaDevices: undefined }),
            'loyalty.cameraUnsupported',
        );
        assert.equal(cameraUnavailable({ isSecureContext: true, mediaDevices: {} }), 'loyalty.cameraUnsupported');
    });

    test('a secure page with camera support can ask for the camera', () => {
        assert.equal(cameraUnavailable({ isSecureContext: true, mediaDevices: camera }), null);
    });

    test('each getUserMedia() failure has its own message', () => {
        const key = (name) => cameraErrorKey(Object.assign(new Error('x'), { name }));
        assert.equal(key('NotAllowedError'), 'loyalty.cameraDenied');
        assert.equal(key('SecurityError'), 'loyalty.cameraDenied');
        assert.equal(key('NotFoundError'), 'loyalty.cameraNotFound');
        assert.equal(key('OverconstrainedError'), 'loyalty.cameraNotFound');
        assert.equal(key('NotReadableError'), 'loyalty.cameraBusy');
        assert.equal(key('AbortError'), 'loyalty.cameraBusy');
        assert.equal(key('TypeError'), 'loyalty.cameraError');
        assert.equal(cameraErrorKey(undefined), 'loyalty.cameraError');
    });

    test('every camera message exists in French and in Arabic', () => {
        const keys = [
            'loyalty.cameraError',
            'loyalty.cameraInsecure',
            'loyalty.cameraUnsupported',
            'loyalty.cameraDenied',
            'loyalty.cameraNotFound',
            'loyalty.cameraBusy',
        ];
        for (const k of keys) {
            for (const lang of ['fr', 'ar']) assert.notEqual(at(lang, k), k, `${k} missing in ${lang}`);
        }
    });
});

describe('reading a QR code', () => {
    let db;
    let alice;
    let zeyd;
    let card;

    before(async () => {
        db = await createDb();
        alice = await signUp(db, 'alice@example.test', { full_name: 'Alice' });
        zeyd = await signUp(db, 'zeyd@example.test');
        await db.query("update public.profiles set role = 'barber' where id = $1", [zeyd]);
        [card] = await as(db, alice, () => rows(db, 'select * from public.my_loyalty()'));
    });

    after(() => db.close());

    test('the scan only looks the card up: no visit and no reward until Zeyd confirms', async () => {
        const qr = `ZEYD-LOYALTY:${card.token}`;
        for (let i = 0; i < 3; i++) {
            const [found] = await as(db, zeyd, () => rows(db, 'select * from public.loyalty_lookup($1)', [qr]));
            assert.equal(found.full_name, 'Alice');
        }
        const count = async (table) =>
            (await rows(db, `select count(*)::int as n from public.${table} where customer_id = $1`, [alice]))[0].n;
        assert.equal(await count('loyalty_visits'), 0);
        assert.equal(await count('loyalty_rewards'), 0);
        const [after] = await as(db, alice, () => rows(db, 'select * from public.my_loyalty()'));
        assert.equal(after.stamps_total, card.stamps_total);
    });
});
