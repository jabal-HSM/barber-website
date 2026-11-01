// Server-side payment logic of the Edge Functions (supabase/functions/_shared), run in Node.
// Stripe and Telegram are simulated: no network, no keys needed.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
    checkoutSessionParams,
    encodeForm,
    hmacSha256Hex,
    verifyStripeSignature,
} from '../supabase/functions/_shared/stripe.ts';
import { PAYMENT_MESSAGE, sendTelegramMessage } from '../supabase/functions/_shared/telegram.ts';
import { handleStripeEvent } from '../supabase/functions/_shared/webhook.ts';

const SECRET = 'whsec_test_secret';

async function signedHeader(payload, timestamp, secret = SECRET) {
    return `t=${timestamp},v1=${await hmacSha256Hex(secret, `${timestamp}.${payload}`)}`;
}

describe('Stripe webhook signature', () => {
    const payload = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });
    const now = 1_800_000_000;

    test('a correctly signed, recent event is accepted', async () => {
        assert.equal(
            await verifyStripeSignature(payload, await signedHeader(payload, now), SECRET, { nowSeconds: now }),
            true,
        );
    });

    test('forged, modified, old or unsigned events are rejected', async () => {
        const header = await signedHeader(payload, now);
        assert.equal(
            await verifyStripeSignature(`${payload} `, header, SECRET, { nowSeconds: now }),
            false,
            'body changed',
        );
        assert.equal(
            await verifyStripeSignature(payload, await signedHeader(payload, now, 'whsec_other'), SECRET, {
                nowSeconds: now,
            }),
            false,
            'wrong secret',
        );
        assert.equal(
            await verifyStripeSignature(payload, header, SECRET, { nowSeconds: now + 3600 }),
            false,
            'replayed later',
        );
        assert.equal(await verifyStripeSignature(payload, null, SECRET, { nowSeconds: now }), false);
        assert.equal(
            await verifyStripeSignature(payload, header, '', { nowSeconds: now }),
            false,
            'no secret configured',
        );
    });
});

describe('Stripe checkout parameters', () => {
    test('amount, currency, return pages and metadata come from the server', () => {
        const params = checkoutSessionParams({
            paymentId: 'pay_1',
            bookingId: '11111111-1111-1111-1111-111111111111',
            amountCents: 1500,
            currency: 'eur',
            productName: 'ZEYD BARBER — Dégradé bas',
            customerEmail: 'client@example.test',
            siteUrl: 'http://127.0.0.1:5501/',
            locale: 'auto',
            nowSeconds: 1000,
        });
        const form = decodeURIComponent(encodeForm(params));
        assert.match(form, /line_items\[0\]\[price_data\]\[unit_amount\]=1500/);
        assert.match(form, /line_items\[0\]\[price_data\]\[currency\]=eur/);
        assert.match(form, /metadata\[payment_id\]=pay_1/);
        assert.match(form, /success_url=http:\/\/127\.0\.0\.1:5501\/paiement\.html\?status=success/);
        assert.equal(params.expires_at, 1000 + 1800);
    });
});

function fakeDb({ newlyPaid = true, claim = [true, false] } = {}) {
    const calls = [];
    const claims = [...claim];
    return {
        calls,
        rpc: async (name, args) => {
            calls.push(name);
            if (name === 'payment_mark_paid')
                return [{ payment_id: 'pay_1', newly_paid: newlyPaid, livemode: args.p_livemode }];
            if (name === 'claim_telegram_notification') return claims.shift() ?? false;
            return null;
        },
    };
}

function fakeTelegram(result = { ok: true }) {
    const sent = [];
    return {
        sent,
        send: async (text) => {
            sent.push(text);
            return result;
        },
    };
}

const paidEvent = (overrides = {}) => ({
    id: 'evt_1',
    type: 'checkout.session.completed',
    livemode: true,
    data: {
        object: { id: 'cs_1', payment_status: 'paid', payment_intent: 'pi_1', amount_total: 1500, currency: 'eur' },
    },
    ...overrides,
});

describe('webhook handling', () => {
    test('a real (live) confirmed payment sends the exact Telegram message once', async () => {
        const db = fakeDb();
        const telegram = fakeTelegram();
        const deps = { rpc: db.rpc, sendTelegram: telegram.send, notifyTestPayments: false };
        const first = await handleStripeEvent(paidEvent(), deps);
        assert.deepEqual(first, { action: 'paid', newlyPaid: true, telegram: 'sent' });
        assert.deepEqual(telegram.sent, [PAYMENT_MESSAGE]);
        assert.equal(
            PAYMENT_MESSAGE,
            'برافو عليك يا هاشم 5 يورو وانت بارك انت اسطوري شفت شلون تعبك بلش يشتغل وربك عم يفتح عليك صلي على النبي🫂',
        );
        // Same payment again (e.g. Stripe retry handled as new by the db): the claim refuses a second message
        const again = await handleStripeEvent(paidEvent({ id: 'evt_2' }), deps);
        assert.equal(again.telegram, 'already_sent');
        assert.equal(telegram.sent.length, 1);
    });

    test('no Telegram message for test payments, unless explicitly enabled', async () => {
        const telegram = fakeTelegram();
        const outcome = await handleStripeEvent(paidEvent({ livemode: false }), {
            rpc: fakeDb().rpc,
            sendTelegram: telegram.send,
            notifyTestPayments: false,
        });
        assert.equal(outcome.telegram, 'skipped');
        assert.equal(telegram.sent.length, 0);
        const enabled = await handleStripeEvent(paidEvent({ livemode: false }), {
            rpc: fakeDb().rpc,
            sendTelegram: telegram.send,
            notifyTestPayments: true,
        });
        assert.equal(enabled.telegram, 'sent');
    });

    test('no message when the database says the payment was already recorded', async () => {
        const db = fakeDb({ newlyPaid: false });
        const telegram = fakeTelegram();
        const outcome = await handleStripeEvent(paidEvent(), {
            rpc: db.rpc,
            sendTelegram: telegram.send,
            notifyTestPayments: false,
        });
        assert.deepEqual(outcome, { action: 'paid', newlyPaid: false, telegram: 'skipped' });
        assert.ok(!db.calls.includes('claim_telegram_notification'));
        assert.equal(telegram.sent.length, 0);
    });

    test('a completed session that is not paid yet (bank debit) is not recorded as paid', async () => {
        const db = fakeDb();
        const outcome = await handleStripeEvent(
            paidEvent({ data: { object: { id: 'cs_1', payment_status: 'unpaid' } } }),
            { rpc: db.rpc, sendTelegram: fakeTelegram().send, notifyTestPayments: false },
        );
        assert.deepEqual(outcome, { action: 'ignored', reason: 'not_paid_yet' });
        assert.deepEqual(db.calls, []);
    });

    test('failed and expired payments are recorded, never notified', async () => {
        for (const [type, action] of [
            ['checkout.session.async_payment_failed', 'failed'],
            ['checkout.session.expired', 'expired'],
        ]) {
            const db = fakeDb();
            const telegram = fakeTelegram();
            const outcome = await handleStripeEvent(paidEvent({ type }), {
                rpc: db.rpc,
                sendTelegram: telegram.send,
                notifyTestPayments: true,
            });
            assert.deepEqual(outcome, { action });
            assert.deepEqual(db.calls, ['payment_mark_failed']);
            assert.equal(telegram.sent.length, 0);
        }
    });

    test('a Telegram failure is recorded and does not fail the payment', async () => {
        const db = fakeDb();
        const outcome = await handleStripeEvent(paidEvent(), {
            rpc: db.rpc,
            sendTelegram: fakeTelegram({ ok: false, error: 'telegram_401: Unauthorized' }).send,
            notifyTestPayments: false,
        });
        assert.equal(outcome.telegram, 'failed');
        assert.ok(db.calls.includes('record_telegram_error'));
    });
});

describe('Telegram sender', () => {
    test('without a token nothing is sent', async () => {
        let called = false;
        const result = await sendTelegramMessage(
            async () => {
                called = true;
                return { ok: true, status: 200, json: async () => ({}) };
            },
            '',
            '8705155832',
            'x',
        );
        assert.deepEqual(result, { ok: false, error: 'telegram_not_configured' });
        assert.equal(called, false);
    });

    test('sends the chat id and text; the error never contains the token', async () => {
        const token = '123456:SECRET-TOKEN';
        let request;
        const ok = await sendTelegramMessage(
            async (url, init) => {
                request = { url, body: JSON.parse(init.body) };
                return { ok: true, status: 200, json: async () => ({ ok: true }) };
            },
            token,
            '8705155832',
            PAYMENT_MESSAGE,
        );
        assert.deepEqual(ok, { ok: true });
        assert.deepEqual(request.body, { chat_id: '8705155832', text: PAYMENT_MESSAGE });
        const failed = await sendTelegramMessage(
            async () => ({ ok: false, status: 401, json: async () => ({ description: 'Unauthorized' }) }),
            token,
            '8705155832',
            'x',
        );
        assert.ok(!failed.error.includes('SECRET-TOKEN'));
    });
});
