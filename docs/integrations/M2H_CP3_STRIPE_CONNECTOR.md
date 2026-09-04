# M2H-CP3 — Stripe payment and invoice connector

Research captured 2026-09-04 from current official Stripe material. CP3 is a
pure Provider Lab read/interpretation adapter over the frozen CP1 trust kernel.
It contains no Stripe SDK or network client, OAuth control plane, persistence,
schema, migration, webhook receiver, financial mutation, execution path, or UI.

## Official sources consulted

- [Invoice object](https://docs.stripe.com/api/invoices/object)
- [InvoicePayment object](https://docs.stripe.com/api/invoice-payment/object)
- [InvoicePayment list](https://docs.stripe.com/api/invoice-payment/list)
- [PaymentIntent object](https://docs.stripe.com/api/payment_intents/object)
- [Charge object](https://docs.stripe.com/api/charges/object)
- [PaymentRecord object](https://docs.stripe.com/api/payment-record/object)
- [PaymentAttemptRecord object](https://docs.stripe.com/api/payment-attempt-record/object)
- [CreditNote object](https://docs.stripe.com/api/credit_notes/object)
- [Customer balance transactions](https://docs.stripe.com/api/customer_balance_transactions)
- [Cash balance transactions](https://docs.stripe.com/api/cash_balance_transactions)
- [Refund object](https://docs.stripe.com/api/refunds/object)
- [Dispute object](https://docs.stripe.com/api/disputes/object)
- [BalanceTransaction object](https://docs.stripe.com/api/balance_transactions/object)
- [Balance object](https://docs.stripe.com/api/balance/balance_retrieve)
- [Payout object](https://docs.stripe.com/api/payouts/object)
- [Event object](https://docs.stripe.com/api/events/object)
- [Webhook lifecycle, raw body and authoritative retrieval](https://docs.stripe.com/webhooks)
- [Connect webhook account scope](https://docs.stripe.com/connect/webhooks)
- [Pagination](https://docs.stripe.com/api/pagination)
- [Rate limits and sandbox limits](https://docs.stripe.com/rate-limits)

The current docs introduce `InvoicePayment`, `PaymentRecord`, and
`PaymentAttemptRecord` alongside older PaymentIntent/Charge flows. CP3 models
those objects explicitly instead of forcing them into one generic payment.

## Identity and mode boundary

The connection context supplies the authenticated DueWatch `tenantId`, expected
Stripe `acct_...` account ID, and exact test/live mode. A Stripe object or event
never chooses the DueWatch tenant. Event `account`, when present, must equal the
expected account; connected-account destinations require it. Event and object
`livemode` values must agree with connection context.

The connection retains the real Stripe account ID as `stripeAccountId`. Because
frozen CP1 has no separate mode member in its admission tuple, CP3 presents the
provider-account scope to CP1 as `<acct-id>:test` or `<acct-id>:live`; this makes
mode mismatch an ordinary fail-closed CP1 provider-account rejection rather than
an ignored extra field. CP3 also scopes object and subject IDs with
`stripe:test:` or `stripe:live:`. Same native ID under different accounts or
different modes therefore remains distinct through admission, observation and
governing selection.

## Observation versus interpretation

The observation is the immutable provider-native object plus a reserved
`__duewatchLivemode` copy of trusted connection mode for object types that do
not expose `livemode`. The interpretation is replaceable. For example, an
Invoice observation retains `amount_due`, `amount_paid`, `amount_remaining`,
status, customer, currency, transitions and the embedded payment-list summary.
Its interpretation says only T1 invoice AR state; it does not infer receipt.

A Charge observation retains `paid`, `captured`, PaymentIntent identity,
refund/dispute context, and balance-transaction identity. CP3 does not treat
`paid=true` alone as receipt because the current Charge reference says it can
also mean a successful authorization for later capture.

## Evidence matrix

| Provider-neutral proposition | Evidence | CP3 decision |
|---|---|---|
| Invoice outstanding balance represents provider AR state | E2 current Invoice reference | T1 / INVOICE_ORIGIN_SOURCE |
| PaymentIntent `succeeded` is processor receipt state | E2 current PaymentIntent reference | T3 / PAYMENT_PROCESSOR |
| Non-succeeded PaymentIntent is attempt state, not receipt | E2 current PaymentIntent status reference | T2 / PAYMENT_PROCESSOR |
| InvoicePayment relates payment value to an invoice | E2 current InvoicePayment object/list | T4 / LEDGER_SOURCE |
| A self-reported/custom PaymentRecord proves Stripe receipt | no support | rejected; T2 with uncertainty |
| A Stripe-reported, Stripe-processor guaranteed PaymentRecord can represent receipt | E2 current PaymentRecord fields | T3 only with all guards |
| Customer/credit value is cash receipt | no support | rejected; T4 only |
| Stripe pending/available balance and payout status are processor settlement | E2 BalanceTransaction/Payout references | T5 / PAYMENT_PROCESSOR |
| Stripe payout or balance establishes bank-ledger reconciliation | no support | T6 unsupported |
| Fixture behavior was observed in a real sandbox | none | E4/E5/E6 unclaimed |

Evidence classes remain kinds, not scores. E3 requires same-provider,
same-proposition schema and documentation components. E7 requires materially
distinct providers with support-bearing evidence. CP3 cannot produce G5.

## Truth mapping

| Stripe object | Dimension | Meaning and guard |
|---|---|---|
| Invoice | T1 | Invoice-origin AR amount/status; paid-out-of-band is not processor proof |
| PaymentIntent non-succeeded | T2 | Processor attempt state |
| PaymentIntent succeeded | T3 | Processor receipt state |
| Charge | T2/T3 | T3 only when paid and captured; shares PaymentIntent receipt identity |
| InvoicePayment | T4 | Invoice allocation relationship; never receipt by itself |
| PaymentRecord/AttemptRecord | T2/T3 | T3 only for Stripe-reported Stripe processor with guaranteed amount |
| CreditNote/customer balance/cash balance transaction | T4 | Credit/allocation context, never cash receipt by name |
| Refund/Dispute | T3 | Receipt reversal/contest context; authoritative related rereads required |
| BalanceTransaction/Balance/Payout | T5 | Stripe processor-funds settlement context |

T6 is explicitly unsupported. Payout `paid`, `reconciliation_status`, bank
trace IDs, and destination data remain T5 context and do not establish
DueWatch bank/ledger reconciliation. Stripe documents that some paid payouts
can later fail, which is retained as uncertainty.

## PaymentRecord boundary

Current Stripe docs say PaymentRecord can be `reported_by=self` or
`reported_by=stripe`, and exposes processor details. CP3 refuses T3 unless all
of these are true: Stripe reported it, `processor_details.type` is `stripe`,
and the processor-guaranteed amount is positive. Self-reported and custom
processor records remain T2 with explicit uncertainty. Invoice application is
still an InvoicePayment T4 fact; PaymentRecord does not allocate itself.

## Events, refetch and pagination

Stripe snapshot Events are notification evidence only. CP3 validates event ID,
type, account scope and test/live mode before creating an invalidation/refetch
obligation. `invoice.paid`, `payment_intent.succeeded`, refunds, disputes,
credits, balance changes and payout changes all cause conservative rereads of
the related objects. Unknown event types broaden the reread. Event payload
state never writes financial truth.

The Stripe webhook docs require exact raw request bytes for signature
verification. Parsed fixture objects are not wire bytes, so CP3 truthfully sets
`signatureVerifiedByAdapter:false`. CP6 owns signatures, durable delivery,
retries, endpoint health, token lifecycle, durable invalidation and refetch.

The pure sync-state fixture requires the full tenant/provider/account/mode tuple
on every page, explicit `has_more`, and a terminal page. Duplicates are
idempotent; older objects cannot replace newer ones; a failed/malformed page
makes the whole read incomplete. An Invoice's embedded `payments` list with
`has_more=true` is incomplete and requires the full InvoicePayment list. Rate
limits and 429 backoff are CP6 runtime concerns and cannot turn a failed page
into an empty source.

## Multicurrency and cross-provider limits

All Stripe monetary values retain their provider-native minor-unit currency.
BalanceTransaction exchange-rate context is preserved, but CP3 performs no
conversion and invents no converted amount. Cross-provider fixtures compare
truth dimensions, never customer/invoice identity. CP7 owns identity and
reconciliation.

## Read-only capability and known unknowns

The adapter declares read `YES`, write `NO`. Stripe APIs can create charges,
refunds, invoices and payouts, but technical capability and OAuth scope grant
no G5 authority and create no DueWatch execution path.

No Stripe credentials were available and no live sandbox call was made. All
fixtures are sanitized deterministic replays; E4/E5/E6 remain unclaimed.
Provider timing, eventual consistency, payment-method-specific guarantees,
late payout failure, dispute lifecycle, and Connect topology require later
live captures. CP6 owns production connection lifecycle; CP7 owns
cross-provider identity; CP3 starts neither.
