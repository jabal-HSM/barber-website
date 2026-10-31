// Revenue allocation rule, in integer cents (same numbers as public.payment_allocation in the database:
// supabase/migrations/20261101120000_phase6_allocations.sql; a test checks both give the same result).
//   10 € → Zeyd 10 €, mother 0 €      15 € → Zeyd 10 €, mother 5 €      anything else → needs review
// The amount must also be the price of the booked service; Stripe payments are created from that price and a
// paid event with another amount is refused (payment_mark_paid), so here the amount alone is enough.
// An allocation is a record, not a transfer of money.

export type Allocation =
    | { qualifying: true; zeydCents: number; motherCents: number }
    | { qualifying: false; zeydCents: null; motherCents: null };

export const ZEYD_CAP_CENTS = 1000;
const QUALIFYING_AMOUNTS = [1000, 1500];

export function allocate(amountCents: number, servicePriceCents: number = amountCents): Allocation {
    const qualifying =
        Number.isInteger(amountCents) && QUALIFYING_AMOUNTS.includes(amountCents) && amountCents === servicePriceCents;
    if (!qualifying) return { qualifying: false, zeydCents: null, motherCents: null };
    const zeydCents = Math.min(amountCents, ZEYD_CAP_CENTS);
    return { qualifying: true, zeydCents, motherCents: amountCents - zeydCents };
}
