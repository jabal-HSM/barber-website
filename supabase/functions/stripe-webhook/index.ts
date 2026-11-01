// POST /functions/v1/stripe-webhook  (called by Stripe only; deployed with --no-verify-jwt)
// Verifies the Stripe signature, then records the payment once and notifies once.
// Secrets: STRIPE_WEBHOOK_SECRET, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (Supabase secrets, never in Git).
import { verifyStripeSignature } from '../_shared/stripe.ts';
import { serviceRpc } from '../_shared/supabase.ts';
import { sendTelegramMessage } from '../_shared/telegram.ts';
import { handleStripeEvent, type StripeEvent } from '../_shared/webhook.ts';

const env = (name: string) => Deno.env.get(name);

Deno.serve(async (req) => {
    if (req.method !== 'POST') return new Response('method_not_allowed', { status: 405 });

    // The raw body must be read as text: the signature is computed on the exact bytes
    const payload = await req.text();
    const valid = await verifyStripeSignature(
        payload,
        req.headers.get('Stripe-Signature'),
        env('STRIPE_WEBHOOK_SECRET') ?? '',
    );
    if (!valid) return new Response('invalid_signature', { status: 400 });

    const event = JSON.parse(payload) as StripeEvent;
    try {
        const outcome = await handleStripeEvent(event, {
            rpc: serviceRpc(env),
            sendTelegram: (text) =>
                sendTelegramMessage(fetch, env('TELEGRAM_BOT_TOKEN') ?? '', env('TELEGRAM_CHAT_ID') ?? '', text),
            notifyTestPayments: env('TELEGRAM_NOTIFY_TEST_PAYMENTS') === 'true',
        });
        // Logs carry the event id and the outcome only (no personal data, no secrets)
        console.log('stripe_event', event.id, event.type, JSON.stringify(outcome));
        return new Response(JSON.stringify({ received: true }), { headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
        console.error('stripe_event_error', event.id, (error as Error).message);
        // 500 → Stripe retries later; already-processed events are ignored by the database
        return new Response('error', { status: 500 });
    }
});
