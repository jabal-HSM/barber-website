// Messages to Zeyd for customer cancellations (supabase/functions/_shared/staffNotify.ts), run in Node.
// The database and Telegram are simulated: no network, no keys.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { deliverStaffNotification, staffMessage } from '../supabase/functions/_shared/staffNotify.ts';

const DATA = {
    customer_name: 'Alice Martin',
    starts_at: '2026-11-07T09:00:00Z', // 10:00 in Paris
    service_fr: 'Dégradé bas',
    service_ar: 'تدرج منخفض',
    reason_code: 'unavailable',
    details: 'Un empêchement <b>au travail</b>',
};

describe('cancellation message', () => {
    test('French: who, when (Paris time), what and why, nothing else', () => {
        const text = staffMessage('cancellation', DATA, 'fr');
        assert.match(text, /Rendez-vous annulé/);
        assert.match(text, /Client : Alice Martin/);
        assert.match(text, /samedi 7 novembre/);
        assert.match(text, /Heure : 10:00/);
        assert.match(text, /Motif : N’est plus disponible/);
        assert.match(text, /Précisions : Un empêchement bau travail\/b/);
        assert.doesNotMatch(text, /@|<|>/, 'no e-mail, no markup');
    });

    test('Arabic version and rescheduling with the new slot', () => {
        const ar = staffMessage('cancellation', DATA, 'ar');
        assert.match(ar, /ألغى الزبون موعده/);
        assert.match(ar, /السبب : لم يعد يستطيع الحضور/);
        const moved = staffMessage('reschedule', {
            ...DATA,
            reason_code: 'reschedule',
            new_starts_at: '2026-11-07T13:30:00Z',
        });
        assert.match(moved, /déplacé/);
        assert.match(moved, /Nouveau créneau : samedi 7 novembre 14:30/);
    });

    test('a missing reason (old cancellation path) is written as such', () => {
        assert.match(staffMessage('cancellation', { customer_name: 'Bob' }), /Motif : Non précisé/);
    });
});

describe('delivery', () => {
    function fakeDb(claimRows) {
        const calls = [];
        return {
            calls,
            rpc: async (name, args) => {
                calls.push([name, args]);
                return name === 'staff_notification_claim' ? claimRows : null;
            },
        };
    }
    const claim = [{ id: 'n1', kind: 'cancellation', data: DATA }];

    test('sent once, then recorded as sent', async () => {
        const db = fakeDb(claim);
        const texts = [];
        const status = await deliverStaffNotification(
            {
                rpc: db.rpc,
                send: async (t) => {
                    texts.push(t);
                    return { ok: true };
                },
            },
            { bookingId: 'b1' },
        );
        assert.equal(status, 'sent');
        assert.equal(texts.length, 1);
        assert.deepEqual(db.calls[1], ['staff_notification_result', { p_id: 'n1', p_status: 'sent', p_error: null }]);
    });

    test('nothing claimed (already sent, refresh) → no message at all', async () => {
        let sent = 0;
        const status = await deliverStaffNotification(
            {
                rpc: fakeDb([]).rpc,
                send: async () => {
                    sent += 1;
                    return { ok: true };
                },
            },
            { bookingId: 'b1' },
        );
        assert.equal(status, 'nothing_to_send');
        assert.equal(sent, 0);
    });

    test('Telegram down → recorded as failed with the reason, for a later retry', async () => {
        const db = fakeDb(claim);
        const status = await deliverStaffNotification(
            { rpc: db.rpc, send: async () => ({ ok: false, error: 'telegram_502: Bad Gateway' }) },
            { bookingId: 'b1' },
        );
        assert.equal(status, 'failed');
        assert.equal(db.calls[1][1].p_status, 'failed');
        assert.match(db.calls[1][1].p_error, /502/);
    });

    test('no chat configured → recorded as not configured, nothing sent', async () => {
        const db = fakeDb(claim);
        assert.equal(
            await deliverStaffNotification({ rpc: db.rpc, send: null }, { bookingId: 'b1' }),
            'not_configured',
        );
        assert.equal(db.calls[1][1].p_status, 'not_configured');
    });

    test('retry is passed to the database only when asked', async () => {
        const db = fakeDb([]);
        await deliverStaffNotification({ rpc: db.rpc, send: null }, { notificationId: 'n1', retry: true });
        assert.deepEqual(db.calls[0][1], { p_id: 'n1', p_booking_id: null, p_retry: true });
    });
});
