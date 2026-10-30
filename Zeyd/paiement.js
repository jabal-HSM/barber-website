// Return page after Stripe Checkout. Coming back here proves nothing: the payment is shown as
// confirmed only when the database says "paid", which only the verified Stripe webhook can write.
import { getCurrentUser } from './api.js';
import { DEFAULT_LANG, LANGUAGES, t } from './i18n.js';
import { getSupabase } from './supabaseClient.js';

const POLL_EVERY_MS = 2000;
const POLL_FOR_MS = 30000;

const params = new URLSearchParams(location.search);
const lang = document.documentElement.lang in LANGUAGES ? document.documentElement.lang : DEFAULT_LANG;
const priceFormatter = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', minimumFractionDigits: 0 });

for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(lang, el.dataset.i18n);
document.title = `${t(lang, 'pay.pageTitle')} | ZEYD BARBER`;

function show(kind, key, values = {}) {
    document.getElementById('paymentSpinner').hidden = kind !== 'waiting';
    const status = document.getElementById('paymentStatus');
    status.className = `payment-status is-${kind}`;
    document.getElementById('paymentText').textContent = t(lang, key, values);
}

async function paymentOf(supabase, bookingId) {
    const { data } = await supabase
        .from('payments')
        .select('status, amount_cents')
        .eq('booking_id', bookingId)
        .order('created_at', { ascending: false });
    return data?.find((p) => p.status === 'paid') ?? data?.[0] ?? null;
}

async function run() {
    const bookingId = params.get('booking');
    if (params.get('status') === 'cancel') {
        show('info', 'pay.cancelled');
        return;
    }
    const supabase = await getSupabase();
    const user = supabase && (await getCurrentUser());
    if (!user || !bookingId) {
        show('info', 'pay.signIn');
        return;
    }
    show('waiting', 'pay.checking');
    const started = Date.now();
    while (Date.now() - started < POLL_FOR_MS) {
        const payment = await paymentOf(supabase, bookingId);
        if (payment?.status === 'paid') {
            show('success', 'pay.confirmed', { amount: priceFormatter.format(payment.amount_cents / 100) });
            return;
        }
        if (payment && ['failed', 'expired'].includes(payment.status)) {
            show('error', 'pay.failed');
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_EVERY_MS));
    }
    show('info', 'pay.pending');
}

run();
