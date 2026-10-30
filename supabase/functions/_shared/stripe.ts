// Stripe helpers without the Stripe SDK: works the same in Deno (Edge Functions) and Node (tests).

const encoder = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
    return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Constant-time comparison of two hex strings
function safeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
    const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
        'sign',
    ]);
    return toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
}

// Verifies the Stripe-Signature header ("t=…,v1=…") of a webhook, as documented by Stripe:
// HMAC-SHA256 of "<timestamp>.<raw body>" with the endpoint secret, and a timestamp within tolerance.
export async function verifyStripeSignature(
    payload: string,
    header: string | null,
    secret: string,
    { toleranceSeconds = 300, nowSeconds = Math.floor(Date.now() / 1000) } = {},
): Promise<boolean> {
    if (!header || !secret) return false;
    const parts = header.split(',').map((p) => p.trim().split('='));
    const timestamp = Number(parts.find(([k]) => k === 't')?.[1]);
    const signatures = parts.filter(([k]) => k === 'v1').map(([, v]) => v ?? '');
    if (!Number.isFinite(timestamp) || signatures.length === 0) return false;
    if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) return false;
    const expected = await hmacSha256Hex(secret, `${timestamp}.${payload}`);
    return signatures.some((sig) => safeEqual(sig, expected));
}

// { a: { b: 1 }, c: [ { d: 2 } ] } -> "a[b]=1&c[0][d]=2" (Stripe's form encoding)
export function encodeForm(data: Record<string, unknown>, prefix = ''): string {
    const out: string[] = [];
    for (const [key, value] of Object.entries(data)) {
        if (value === undefined || value === null) continue;
        const name = prefix ? `${prefix}[${key}]` : key;
        if (typeof value === 'object') {
            out.push(encodeForm(value as Record<string, unknown>, name));
        } else {
            out.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
        }
    }
    return out.filter(Boolean).join('&');
}

export type CheckoutInput = {
    paymentId: string;
    bookingId: string;
    amountCents: number;
    currency: string;
    productName: string;
    customerEmail?: string;
    siteUrl: string;
    locale: 'fr' | 'auto';
    nowSeconds?: number;
};

// Parameters of a Stripe Checkout Session for one booking. The amount comes from the database.
export function checkoutSessionParams(input: CheckoutInput): Record<string, unknown> {
    const base = input.siteUrl.replace(/\/+$/, '');
    const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
    return {
        mode: 'payment',
        locale: input.locale,
        client_reference_id: input.paymentId,
        customer_email: input.customerEmail,
        // Short-lived page: an abandoned payment cannot be completed hours later
        expires_at: now + 30 * 60,
        line_items: [
            {
                quantity: 1,
                price_data: {
                    currency: input.currency,
                    unit_amount: input.amountCents,
                    product_data: { name: input.productName },
                },
            },
        ],
        metadata: { payment_id: input.paymentId, booking_id: input.bookingId },
        payment_intent_data: { metadata: { payment_id: input.paymentId, booking_id: input.bookingId } },
        success_url: `${base}/paiement.html?status=success&booking=${input.bookingId}`,
        cancel_url: `${base}/paiement.html?status=cancel&booking=${input.bookingId}`,
    };
}
