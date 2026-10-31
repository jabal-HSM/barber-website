# Payments — what exists, what is possible, what is still manual

Last checked: 2026-10-31. Stripe is in **test mode**; live payments are blocked by the server
(`ALLOW_LIVE_PAYMENTS=false`, live keys refused). Nothing here moves real money.

## 1. The three steps, kept apart

| Step | Where it is recorded | Proof |
|---|---|---|
| 1. Payment received | `payments.status = 'paid'` | a **signed** Stripe event (`stripe-webhook`, signature + idempotency), or a staff member recording cash / card terminal / a bank transfer **checked in the bank's own app** (`staff_record_payment`) |
| 2. Allocation calculated | `payment_allocations` (one row per paid payment) | database rule, integer cents |
| 3. Money really paid out to Zeyd / the mother | `payment_allocations.mother_transfer = 'transferred'` | an admin records it by hand, with the bank reference, **after** doing the transfer |

A screenshot, a typed reference or anything sent by a customer never marks a payment as paid.

## 2. Allocation rule (to confirm with the owner)

- Qualifying payment = amount equal to the price of the booked service **and** 10 € or 15 €.
- 10 € → Zeyd 10 €, mother 0 €. 15 € → Zeyd 10 €, mother 5 €.
- Any other amount → `needs_review`, no split invented.
- Same rule in SQL (`public.payment_allocation`) and in the Edge Functions (`_shared/allocation.ts`); a test
  checks they agree.
- Change from before: Zeyd's share was "amount − 5 €" (5 € on a 10 € payment). It is now 10 €.
- Hashem's Telegram message ("… 5 يورو …") is now sent only for a payment that really has the 5 € share
  (15 €), still once per real payment.

## 3. Payment methods (Stripe Checkout)

The checkout session does not force a list of methods, so the methods shown are the ones **enabled in the
Stripe Dashboard** (Settings → Payment methods), for the device and the customer's country:

- **Visa / Mastercard (and Cartes Bancaires)**: cards, available by default.
- **Google Pay / Apple Pay**: wallets shown on top of cards when the phone supports them; enable them in the
  Dashboard. Some French users report Google Pay not appearing until it is enabled there; check on a real phone.
- **PayPal**: supported by Stripe for businesses in the EEA (France included); must be enabled in the
  Dashboard (PayPal is linked during that step). No code change needed.

Sources: [Stripe Checkout](https://docs.stripe.com/checkout),
[PayPal with Stripe](https://edge-docs.stripe.com/payments/paypal/accept-a-payment),
[Google Pay with Stripe](https://stripe.com/en-nl/payment-method/google-pay).

## 4. Fees (to verify on Stripe's own page before going live)

Third-party summaries give about **1.5 % + 0.25 €** for standard French cards, about 1.4 % + 0.25 € for other
EEA cards, and higher rates for business cards and non-EEA cards. On a 15 € payment that is about 0.48 €.
Who bears the fee (out of Zeyd's 10 € or the mother's 5 €) is a **business decision still to make**: the
current rule ignores fees. Check [stripe.com/fr/pricing](https://stripe.com/fr/pricing).

## 5. Automatic split between two people — not implemented, and why

Today the whole amount arrives on the Stripe account whose keys are configured (the mother's). Splitting
automatically needs **Stripe Connect**:

- The mother's account becomes the *platform*; Zeyd gets a *connected account* that receives 10 € per payment
  (destination charges or "separate charges and transfers").
- Connected accounts of type Express/Custom require the holder to be **18 or older**
  ([Stripe age requirement](https://support.stripe.com/questions/age-requirement-to-create-a-stripe-account));
  a minor needs a legal guardian flow. **Zeyd's age decides whether this is possible.**
- For French platforms, connected accounts must be created through **Stripe-hosted onboarding** and
  identity verification ([Stripe custom accounts](https://docs.stripe.com/connect/custom-accounts)).
- Both accounts need their own verified identity and a bank account (IBAN) in their own name.
- Platform/Connect pricing applies in addition to card fees.

Until that is decided and set up, the safe workflow is **manual**: the money stays on the mother's account,
the dashboard shows per payment what is due to whom, and an admin records each real transfer
(« Marquer les 5 € comme versés »). The same applies to Zeyd's 10 € if they are paid out by hand.

## 6. Bank transfers

No bank API is connected. A transfer is confirmed only by a staff member who has **seen it in the bank's
official app**, and the reference is required. Banks do not send the site any notification.

## 7. Questions for the owner before production

1. Confirm the rule 10 € → 10/0 and 15 € → 10/5, and who pays the Stripe fee.
2. Is Zeyd 18 or older (Connect possible) or should payouts stay manual?
3. The mother's notification: when a payment is recorded? when her 5 € is calculated? only when it reaches
   her bank? Today nothing is sent to her (only Hashem's message and Zeyd's dashboard).
4. Who may record cash payments: Zeyd (staff) — as implemented — or admins only?
