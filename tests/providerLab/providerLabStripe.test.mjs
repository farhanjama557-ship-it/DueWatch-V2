import test from 'node:test'
import assert from 'node:assert/strict'
import { PROVIDER_TRUTH_DIMENSION as T } from '../../src/lib/integrations/providerTruthModel.js'
import { FRESHNESS_STATE } from '../../src/lib/integrations/providerFreshness.js'
import { PROVIDER_CLAIM_ADMISSION, governingClaims } from '../../src/lib/integrations/providerContract.js'
import { stripeAdapter as STRIPE, STRIPE_PROVIDER, createStripeSyncState } from '../../src/lib/providerAdapters/payments/stripeAdapter.js'
import { observeStripe, stripeInvoice, paymentIntent, stripeEvent, CP3_NOW } from './stripeHarness.mjs'

const C = Object.freeze({ tenantId: 'dw-a', provider: STRIPE_PROVIDER,
  providerAccountId: 'acct_a', livemode: false })
const LIVE = Object.freeze({ ...C, livemode: true })
const OTHER = Object.freeze({ ...C, providerAccountId: 'acct_b' })

const obs = (objectType, payload, options = {}) => observeStripe(STRIPE,
  { connection: C, objectType, payload, ...options })

test('S1 open Invoice produces current T1 AR state', () => {
  const r = obs('Invoice', stripeInvoice())
  assert.equal(r.interpretation.truthDimension, T.T1_INVOICE_AR_STATE)
  assert.equal(r.interpretation.value.amountRemaining, 10_000)
  assert.equal(r.admitted.admitted, true)
})

test('S2 paid zero-balance Invoice is T1 and not receipt proof', () => {
  const r = obs('Invoice', stripeInvoice('in_paid', { status: 'paid', amount_paid: 10_000, amount_remaining: 0 }))
  assert.equal(r.interpretation.truthDimension, T.T1_INVOICE_AR_STATE)
  assert.equal(r.interpretation.value.provesProcessorReceipt, false)
})

test('S3 partial Invoice preserves amount paid and remaining', () => {
  const r = obs('Invoice', stripeInvoice('in_partial', { amount_paid: 4_000, amount_remaining: 6_000 }))
  assert.deepEqual([r.interpretation.value.amountPaid, r.interpretation.value.amountRemaining], [4_000, 6_000])
})

test('S4 attempted invoice stays T1 rather than inventing T2 or T3', () => {
  const r = obs('Invoice', stripeInvoice('in_attempted', { attempted: true, attempt_count: 2 }))
  assert.equal(r.interpretation.truthDimension, T.T1_INVOICE_AR_STATE)
})

test('S5 PaymentIntent requires_payment_method is T2', () => {
  assert.equal(obs('PaymentIntent', paymentIntent()).interpretation.truthDimension,
    T.T2_PAYMENT_ATTEMPT_STATE)
})

test('S6 processing PaymentIntent does not become receipt', () => {
  const r = obs('PaymentIntent', paymentIntent('pi_processing', { status: 'processing' }))
  assert.equal(r.interpretation.truthDimension, T.T2_PAYMENT_ATTEMPT_STATE)
  assert.equal(r.interpretation.value.processorReceiptEstablished, false)
})

test('S7 succeeded PaymentIntent is T3 processor receipt', () => {
  const r = obs('PaymentIntent', paymentIntent('pi_ok', { status: 'succeeded', amount_received: 10_000 }))
  assert.equal(r.interpretation.truthDimension, T.T3_PAYMENT_RECEIPT_STATE)
  assert.equal(r.interpretation.value.processorReceiptEstablished, true)
})

test('contradictory succeeded PaymentIntent with zero received fails closed to T2', () => {
  const r = obs('PaymentIntent', paymentIntent('pi_zero', { status: 'succeeded', amount_received: 0 }))
  assert.equal(r.interpretation.truthDimension, T.T2_PAYMENT_ATTEMPT_STATE)
  assert.equal(r.interpretation.value.processorReceiptEstablished, false)
})

test('S8 Charge and PaymentIntent share one receipt subject', () => {
  const pi = obs('PaymentIntent', paymentIntent('pi_shared', { status: 'succeeded', amount_received: 10_000 }))
  const ch = obs('Charge', { id: 'ch_1', object: 'charge', livemode: false,
    payment_intent: 'pi_shared', paid: true, captured: true, amount: 10_000,
    amount_captured: 10_000, amount_refunded: 0, currency: 'usd', created: 1788541200 })
  assert.equal(ch.interpretation.truthDimension, T.T3_PAYMENT_RECEIPT_STATE)
  assert.equal(ch.interpretation.subject, pi.interpretation.subject)
})

test('paid but uncaptured-value Charge cannot establish receipt', () => {
  const r = obs('Charge', { id: 'ch_zero', livemode: false, paid: true, captured: true,
    amount: 10_000, amount_captured: 0, currency: 'usd' })
  assert.equal(r.interpretation.truthDimension, T.T2_PAYMENT_ATTEMPT_STATE)
})

test('S9 InvoicePayment is T4 allocation and never receipt proof', () => {
  const r = obs('InvoicePayment', { id: 'inpay_1', object: 'invoice_payment', livemode: false,
    invoice: 'in_1', status: 'paid', amount_requested: 10_000, amount_paid: 10_000,
    currency: 'usd', payment: { type: 'payment_intent', payment_intent: 'pi_1' } })
  assert.equal(r.interpretation.truthDimension, T.T4_PAYMENT_CREDIT_ALLOCATION_STATE)
  assert.equal(r.interpretation.value.provesProcessorReceipt, false)
})

test('S10 one payment allocated across invoices remains separate T4 relationships', () => {
  const make = (id, invoice) => obs('InvoicePayment', { id, livemode: false, invoice,
    status: 'paid', amount_requested: 5_000, amount_paid: 5_000, currency: 'usd',
    payment: { type: 'payment_intent', payment_intent: 'pi_many' } }).interpretation
  const allocations = [make('inpay_a', 'in_a'), make('inpay_b', 'in_b')]
  assert.equal(new Set(allocations.map((x) => x.subject)).size, 2)
  assert.ok(allocations.every((x) => x.truthDimension === T.T4_PAYMENT_CREDIT_ALLOCATION_STATE))
})

test('S11 partial InvoicePayment preserves requested versus paid', () => {
  const r = obs('InvoicePayment', { id: 'inpay_partial', livemode: false, invoice: 'in_1',
    status: 'paid', amount_requested: 10_000, amount_paid: 4_000, currency: 'usd',
    payment: { type: 'payment_intent', payment_intent: 'pi_partial' } })
  assert.deepEqual([r.interpretation.value.amountRequested, r.interpretation.value.amountPaid], [10_000, 4_000])
})

test('S12 canceled InvoicePayment is not silently allocated as paid', () => {
  const r = obs('InvoicePayment', { id: 'inpay_bad', livemode: false, invoice: 'in_1',
    status: 'canceled', amount_requested: 10_000, amount_paid: null, currency: 'usd', payment: {} })
  assert.equal(r.interpretation.value.status, 'canceled')
  assert.equal(r.interpretation.value.amountPaid, null)
})

test('S13 Stripe-reported Stripe-processor PaymentRecord with guarantee can prove T3', () => {
  const r = obs('PaymentRecord', { id: 'pr_stripe', livemode: false, reported_by: 'stripe',
    processor_details: { type: 'stripe' }, amount_requested: { value: 1000, currency: 'usd' },
    amount_guaranteed: { value: 1000, currency: 'usd' }, created: 1788541200 })
  assert.equal(r.interpretation.truthDimension, T.T3_PAYMENT_RECEIPT_STATE)
  assert.equal(r.interpretation.value.stripeProcessorReceiptEstablished, true)
})

test('S14 self-reported off-Stripe PaymentRecord does not prove receipt', () => {
  const r = obs('PaymentRecord', { id: 'pr_off', livemode: false, reported_by: 'self',
    processor_details: { type: 'custom' }, amount_guaranteed: { value: 1000, currency: 'usd' } })
  assert.equal(r.interpretation.truthDimension, T.T2_PAYMENT_ATTEMPT_STATE)
  assert.equal(r.interpretation.value.stripeProcessorReceiptEstablished, false)
})

test('S15 custom-processor PaymentRecord stays non-receipt even if labeled guaranteed', () => {
  const r = obs('PaymentRecord', { id: 'pr_custom', livemode: false, reported_by: 'stripe',
    processor_details: { type: 'custom' }, amount_guaranteed: { value: 1000, currency: 'usd' } })
  assert.equal(r.interpretation.truthDimension, T.T2_PAYMENT_ATTEMPT_STATE)
})

test('S16 PaymentAttemptRecord is T2 without exact Stripe receipt provenance', () => {
  const r = obs('PaymentAttemptRecord', { id: 'par_1', payment_record: 'pr_1', livemode: false,
    reported_by: 'self', processor_details: { type: 'custom' },
    amount_requested: { value: 1000, currency: 'usd' } })
  assert.equal(r.interpretation.truthDimension, T.T2_PAYMENT_ATTEMPT_STATE)
})

test('S17 CreditNote is T4 credit context, not cash receipt', () => {
  const r = obs('CreditNote', { id: 'cn_1', livemode: false, invoice: 'in_1', customer: 'cus_1',
    amount: 500, currency: 'usd', created: 1788541200 })
  assert.equal(r.interpretation.truthDimension, T.T4_PAYMENT_CREDIT_ALLOCATION_STATE)
  assert.equal(r.interpretation.value.provesProcessorReceipt, false)
})

test('S18 customer balance credit without invoice remains unapplied T4 context', () => {
  const r = obs('CustomerBalanceTransaction', { id: 'cbtxn_1', customer: 'cus_1',
    amount: -500, ending_balance: -500, currency: 'usd', type: 'adjustment', created: 1788541200 })
  assert.equal(r.interpretation.value.appliedToInvoice, false)
  assert.deepEqual(r.interpretation.uncertainty, ['NO_INVOICE_ALLOCATION_EVIDENCE'])
})

test('S19 paid-out-of-band Invoice is T1 and explicitly not Stripe receipt', () => {
  const r = obs('Invoice', stripeInvoice('in_oob', { status: 'paid', amount_paid: 10_000,
    amount_paid_off_stripe: 10_000, amount_remaining: 0 }))
  assert.equal(r.interpretation.truthDimension, T.T1_INVOICE_AR_STATE)
  assert.ok(r.interpretation.uncertainty.includes('OFF_STRIPE_AMOUNT_IS_INVOICE_STATE_NOT_STRIPE_PROCESSOR_RECEIPT'))
})

test('S20 Refund records receipt reversal and requires invoice refetch', () => {
  const r = obs('Refund', { id: 're_1', payment_intent: 'pi_1', charge: 'ch_1', amount: 1000,
    currency: 'usd', status: 'succeeded', created: 1788541200 })
  assert.equal(r.interpretation.truthDimension, T.T3_PAYMENT_RECEIPT_STATE)
  assert.equal(r.interpretation.value.reopensInvoiceAr, false)
})

test('S21 Dispute is contested receipt context, never inferred AR reopening', () => {
  const r = obs('Dispute', { id: 'dp_1', livemode: false, payment_intent: 'pi_1', charge: 'ch_1',
    amount: 1000, currency: 'usd', status: 'needs_response', balance_transactions: [] })
  assert.equal(r.interpretation.value.receiptReversalOrContest, true)
  assert.equal(r.interpretation.value.reopensInvoiceAr, false)
})

test('S22 refund event requires broad authoritative reread', () => {
  const r = STRIPE.parseChangeEvent({ connection: C, envelope: stripeEvent('refund.updated') })
  assert.equal(r.obligation.stateWrittenFromEvent, false)
  assert.ok(r.obligation.targets.includes('invoice'))
  assert.ok(r.obligation.targets.includes('balance_transaction'))
})

test('S23 stale processor observation cannot govern', () => {
  const r = obs('PaymentIntent', paymentIntent('pi_stale', { status: 'succeeded' }),
    { observedAt: '2020-01-01T00:00:00Z' })
  assert.equal(r.freshness.state, FRESHNESS_STATE.STALE)
  assert.equal(governingClaims([r.admitted], T.T3_PAYMENT_RECEIPT_STATE).governing.length, 0)
})

test('S24 unavailable Stripe source is not an empty fresh source', () => {
  const r = obs('Invoice', stripeInvoice(), { freshness: { sourceAvailable: false } })
  assert.equal(r.freshness.state, FRESHNESS_STATE.SOURCE_UNAVAILABLE)
})

test('S25 duplicate event is idempotent at obligation identity', () => {
  const event = stripeEvent('payment_intent.succeeded')
  assert.deepEqual(STRIPE.parseChangeEvent({ connection: C, envelope: event }).obligation,
    STRIPE.parseChangeEvent({ connection: C, envelope: event }).obligation)
})

test('S26 out-of-order page item cannot replace newer object', () => {
  const sync = createStripeSyncState(C)
  sync.ingestPage({ connection: C, hasMore: true, items: [{ objectType: 'Invoice',
    externalObjectId: 'in_1', versionAt: CP3_NOW, payload: { amount_remaining: 10 } }] })
  sync.ingestPage({ connection: C, hasMore: false, items: [{ objectType: 'Invoice',
    externalObjectId: 'in_1', versionAt: '2026-09-03T00:00:00Z', payload: { amount_remaining: 99 } }] })
  assert.equal(sync.snapshot.items[0].payload.amount_remaining, 10)
})

test('S27 test/live event mismatch is rejected before invalidation', () => {
  assert.deepEqual(STRIPE.parseChangeEvent({ connection: C,
    envelope: stripeEvent('invoice.updated', { livemode: true }) }),
  { accepted: false, reason: 'REJECTED_STRIPE_MODE', stateWrittenFromEvent: false })
})

test('S28 wrong Stripe account is rejected before invalidation', () => {
  assert.equal(STRIPE.parseChangeEvent({ connection: C,
    envelope: stripeEvent('invoice.updated', { account: 'acct_b' }) }).reason, 'REJECTED_STRIPE_ACCOUNT')
})

test('S29 same object ID under two Stripe accounts does not collide', () => {
  const a = observeStripe(STRIPE, { connection: C, objectType: 'Invoice', payload: stripeInvoice('same') })
  const b = observeStripe(STRIPE, { connection: OTHER, objectType: 'Invoice', payload: stripeInvoice('same') })
  assert.notEqual(a.observation.id, b.observation.id)
})

test('S30 same object ID in test and live mode does not collide', () => {
  const a = observeStripe(STRIPE, { connection: C, objectType: 'Invoice', payload: stripeInvoice('same') })
  const b = observeStripe(STRIPE, { connection: LIVE, objectType: 'Invoice',
    payload: stripeInvoice('same', { livemode: true }) })
  assert.notEqual(a.observation.externalObjectId, b.observation.externalObjectId)
  assert.notEqual(a.observation.id, b.observation.id)
})

test('S31 incomplete and failed pages never report complete', () => {
  const sync = createStripeSyncState(C)
  assert.equal(sync.ingestPage({ connection: C, hasMore: true }).syncComplete, false)
  assert.equal(sync.ingestPage({ connection: C, failed: true }).syncComplete, false)
  assert.equal(sync.ingestPage({ connection: C, hasMore: false }).syncComplete, false)
})

test('S32 truncated embedded Invoice payments require full paginated reread', () => {
  const r = obs('Invoice', stripeInvoice('in_truncated', { payments: { object: 'list',
    data: [{ id: 'inpay_1' }], has_more: true, total_count: 3, url: '/v1/invoice_payments' } }))
  assert.equal(r.interpretation.value.paymentListComplete, false)
  assert.ok(r.interpretation.uncertainty.includes('INVOICE_PAYMENT_LIST_INCOMPLETE_AUTHORITATIVE_PAGE_REQUIRED'))
})

test('S33 multicurrency values remain provider-native without conversion truth', () => {
  const r = obs('BalanceTransaction', { id: 'txn_fx', amount: 1000, fee: 30, net: 970,
    currency: 'eur', exchange_rate: 1.11, status: 'available', available_on: 1788541200 })
  assert.equal(r.interpretation.value.currency, 'eur')
  assert.equal(r.interpretation.value.exchangeRate, 1.11)
  assert.equal(Object.hasOwn(r.interpretation.value, 'convertedAmount'), false)
})

test('S34 pending BalanceTransaction is T5 only', () => {
  const r = obs('BalanceTransaction', { id: 'txn_pending', amount: 1000, fee: 30, net: 970,
    currency: 'usd', status: 'pending', created: 1788541200 })
  assert.equal(r.interpretation.truthDimension, T.T5_PROCESSOR_FUNDS_SETTLEMENT_STATE)
})

test('S35 available BalanceTransaction stays processor T5, not bank reconciliation', () => {
  const r = obs('BalanceTransaction', { id: 'txn_available', amount: 1000, fee: 30, net: 970,
    currency: 'usd', status: 'available', available_on: 1788541200 })
  assert.equal(r.interpretation.truthDimension, T.T5_PROCESSOR_FUNDS_SETTLEMENT_STATE)
  assert.equal(r.interpretation.value.establishesBankLedgerReconciliation, false)
})

test('S36 pending Payout is T5 processor settlement state', () => {
  assert.equal(obs('Payout', { id: 'po_pending', livemode: false, amount: 970, currency: 'usd',
    status: 'pending', created: 1788541200 }).interpretation.truthDimension,
  T.T5_PROCESSOR_FUNDS_SETTLEMENT_STATE)
})

test('S37 paid Payout still does not establish T6', () => {
  const r = obs('Payout', { id: 'po_paid', livemode: false, amount: 970, currency: 'usd',
    status: 'paid', reconciliation_status: 'completed', created: 1788541200 })
  assert.equal(r.interpretation.truthDimension, T.T5_PROCESSOR_FUNDS_SETTLEMENT_STATE)
  assert.equal(r.interpretation.value.establishesBankLedgerReconciliation, false)
})

test('S38 failed Payout preserves failure reversal context', () => {
  const r = obs('Payout', { id: 'po_failed', livemode: false, amount: 970, currency: 'usd',
    status: 'failed', failure_balance_transaction: 'txn_reverse', created: 1788541200 })
  assert.equal(r.interpretation.value.failureBalanceTransactionId, 'txn_reverse')
})

test('S39 invoice webhook is invalidation and authoritative refetch only', () => {
  const r = STRIPE.parseChangeEvent({ connection: C, envelope: stripeEvent('invoice.paid') })
  assert.equal(r.accepted, true)
  assert.equal(r.obligation.stateWrittenFromEvent, false)
  assert.deepEqual(r.obligation.livemode, false)
})

test('S40 connected-account event cannot omit account context', () => {
  const connected = { ...C, eventScope: 'CONNECTED_ACCOUNT' }
  const r = STRIPE.parseChangeEvent({ connection: connected,
    envelope: stripeEvent('invoice.updated', { account: null }) })
  assert.equal(r.reason, 'REJECTED_STRIPE_ACCOUNT')
})

test('wrong DueWatch tenant, provider and account are rejected by frozen CP1 admission', () => {
  const cases = [
    [{ ...C, tenantId: 'dw-b' }, PROVIDER_CLAIM_ADMISSION.REJECTED_TENANT],
    [{ ...C, provider: 'quickbooks_online' }, PROVIDER_CLAIM_ADMISSION.REJECTED_PROVIDER],
    [{ ...C, providerAccountId: 'acct_b' }, PROVIDER_CLAIM_ADMISSION.REJECTED_PROVIDER_ACCOUNT],
  ]
  for (const [expectedConnection, admission] of cases) {
    assert.equal(obs('Invoice', stripeInvoice(), { expectedConnection }).admitted.admission, admission)
  }
})

test('object mode mismatch is rejected before CP1 observation construction', () => {
  assert.throws(() => obs('Invoice', stripeInvoice('in_live', { livemode: true })), /livemode/)
})

test('frozen CP1 admission rejects a test observation when live connection scope is expected', () => {
  const result = obs('Invoice', stripeInvoice(), { expectedConnection: LIVE })
  assert.equal(result.admitted.admission, PROVIDER_CLAIM_ADMISSION.REJECTED_PROVIDER_ACCOUNT)
})

test('Stripe capability remains read-only and cannot grant authority or execute', () => {
  assert.deepEqual(STRIPE.supportedByDuewatchAdapter, { read: 'YES', write: 'NO' })
})
