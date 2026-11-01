// What to do with a verified Stripe event. Pure logic: the database calls and the Telegram sender
// are passed in, so the same code runs in the Edge Function and in the Node tests.
import { allocate } from './allocation.ts';
import { PAYMENT_MESSAGE } from './telegram.ts';

type Rpc = (name: string, args: Record<string, unknown>) => Promise<unknown>;
type SendTelegram = (text: string) => Promise<{ ok: true } | { ok: false; error: string }>;

export type StripeEvent = {
    id: string;
    type: string;
    livemode: boolean;
    data: {
        object: {
            id: string;
            payment_status?: string;
            payment_intent?: string | null;
            amount_total?: number | null;
            currency?: string | null;
        };
    };
};

type PaidRow = { payment_id: string | null; newly_paid: boolean; livemode: boolean; amount_cents?: number | null };

export type Outcome =
    | { action: 'ignored'; reason: string }
    | { action: 'paid'; newlyPaid: boolean; telegram: 'sent' | 'skipped' | 'already_sent' | 'failed' | 'not_due' }
    | { action: 'failed' | 'expired' };

export async function handleStripeEvent(
    event: StripeEvent,
    deps: { rpc: Rpc; sendTelegram: SendTelegram; notifyTestPayments: boolean },
): Promise<Outcome> {
    const session = event.data?.object;
    if (!session?.id) return { action: 'ignored', reason: 'no_session' };

    switch (event.type) {
        case 'checkout.session.completed':
        case 'checkout.session.async_payment_succeeded': {
            // "completed" can arrive before the money (bank debits): only "paid" counts
            if (session.payment_status !== 'paid') return { action: 'ignored', reason: 'not_paid_yet' };
            const rows = (await deps.rpc('payment_mark_paid', {
                p_event_id: event.id,
                p_event_type: event.type,
                p_session_id: session.id,
                p_payment_intent_id: session.payment_intent ?? null,
                p_amount_total: session.amount_total ?? null,
                p_currency: session.currency ?? null,
                p_livemode: event.livemode,
            })) as PaidRow[];
            const row = rows?.[0];
            if (!row?.newly_paid || !row.payment_id) {
                return { action: 'paid', newlyPaid: false, telegram: 'skipped' };
            }
            // The message announces the 5 € share: only for a payment that has one (15 €, not 10 €)
            if ((allocate(Number(row.amount_cents ?? session.amount_total)).motherCents ?? 0) <= 0) {
                return { action: 'paid', newlyPaid: true, telegram: 'not_due' };
            }
            // Telegram only for real payments, unless explicitly enabled for a test
            if (!event.livemode && !deps.notifyTestPayments) {
                return { action: 'paid', newlyPaid: true, telegram: 'skipped' };
            }
            const claimed = await deps.rpc('claim_telegram_notification', { p_payment_id: row.payment_id });
            if (claimed !== true) return { action: 'paid', newlyPaid: true, telegram: 'already_sent' };
            const sent = await deps.sendTelegram(PAYMENT_MESSAGE);
            if (!sent.ok) {
                await deps.rpc('record_telegram_error', { p_payment_id: row.payment_id, p_error: sent.error });
                return { action: 'paid', newlyPaid: true, telegram: 'failed' };
            }
            return { action: 'paid', newlyPaid: true, telegram: 'sent' };
        }
        case 'checkout.session.async_payment_failed':
        case 'checkout.session.expired': {
            const status = event.type === 'checkout.session.expired' ? 'expired' : 'failed';
            await deps.rpc('payment_mark_failed', {
                p_event_id: event.id,
                p_event_type: event.type,
                p_session_id: session.id,
                p_status: status,
            });
            return { action: status };
        }
        default:
            return { action: 'ignored', reason: 'unhandled_type' };
    }
}
