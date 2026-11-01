// POST /functions/v1/create-checkout  { booking_id }  (called by the site for a signed-in customer)
// Creates a Stripe Checkout page for the customer's own booking and returns its URL.
// The secret key stays here (Supabase secret STRIPE_SECRET_KEY); the amount comes from the database.
import { checkoutSessionParams, encodeForm } from '../_shared/stripe.ts';
import { getUser, serviceRpc } from '../_shared/supabase.ts';

const env = (name: string) => Deno.env.get(name);

function corsHeaders(origin: string | null): Record<string, string> {
    const allowed = (env('ALLOWED_ORIGINS') ?? env('SITE_URL') ?? '')
        .split(',')
        .map((o) => o.trim().replace(/\/+$/, ''));
    return {
        'Access-Control-Allow-Origin': origin && allowed.includes(origin) ? origin : (allowed[0] ?? ''),
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        Vary: 'Origin',
    };
}

Deno.serve(async (req) => {
    const cors = corsHeaders(req.headers.get('Origin'));
    const reply = (status: number, body: Record<string, unknown>) =>
        new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
    if (req.method !== 'POST') return reply(405, { error: 'method_not_allowed' });

    const stripeKey = env('STRIPE_SECRET_KEY');
    const siteUrl = env('SITE_URL');
    if (!stripeKey || !siteUrl) return reply(503, { error: 'payments_not_configured' });
    // Safety net while the mother's account is not verified: refuse live keys unless explicitly allowed
    if (stripeKey.startsWith('sk_live_') && env('ALLOW_LIVE_PAYMENTS') !== 'true') {
        return reply(503, { error: 'live_payments_not_allowed' });
    }

    const user = await getUser(env, req.headers.get('Authorization'));
    if (!user) return reply(401, { error: 'auth_required' });

    const { booking_id: bookingId } = (await req.json().catch(() => ({}))) as { booking_id?: string };
    if (!bookingId || !/^[0-9a-f-]{36}$/i.test(bookingId)) return reply(400, { error: 'not_found' });

    const rpc = serviceRpc(env);
    let pending: { payment_id: string; amount_cents: number; currency: string; service_name_fr: string };
    try {
        const rows = (await rpc('payment_create_pending', { p_booking_id: bookingId, p_customer_id: user.id })) as [
            typeof pending,
        ];
        pending = rows[0];
    } catch (error) {
        return reply(400, { error: (error as Error).message });
    }

    const params = checkoutSessionParams({
        paymentId: pending.payment_id,
        bookingId,
        amountCents: pending.amount_cents,
        currency: pending.currency,
        productName: `ZEYD BARBER — ${pending.service_name_fr}`,
        customerEmail: user.email,
        siteUrl,
        locale: 'auto',
    });

    const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${stripeKey}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            // Retrying the same payment never creates two Stripe sessions
            'Idempotency-Key': pending.payment_id,
        },
        body: encodeForm(params),
    });
    const session = (await response.json()) as { id?: string; url?: string; error?: { type?: string } };
    if (!response.ok || !session.id || !session.url) {
        console.error('stripe_checkout_error', response.status, session.error?.type ?? 'unknown');
        return reply(502, { error: 'stripe_error' });
    }

    await rpc('payment_attach_session', { p_payment_id: pending.payment_id, p_session_id: session.id });
    return reply(200, { url: session.url });
});
