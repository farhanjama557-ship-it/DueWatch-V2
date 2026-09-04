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

test('corpus S3 Invoice paid by PaymentIntent keeps T1 separate from T3', () => {
  const invoice = obs('Invoice', stripeInvoice('in_s3', { status: 'paid', amount_paid: 10_000,
    amount_remaining: 0 }))
  const receipt = obs('PaymentIntent', paymentIntent('pi_s3', { status: 'succeeded', amount_received: 10_000 }))
  assert.deepEqual([invoice.interpretation.truthDimension, receipt.interpretation.truthDimension],
    [T.T1_INVOICE_AR_STATE, T.T3_PAYMENT_RECEIPT_STATE])
})

test('corpus S5 customer credit can zero Invoice without proving T3', () => {
  const r = obs('Invoice', stripeInvoice('in_credit', { status: 'paid', amount_due: 0,
    amount_paid: 0, amount_remaining: 0, starting_balance: -10_000 }))
  assert.equal(r.interpretation.truthDimension, T.T1_INVOICE_AR_STATE)
  assert.equal(r.interpretation.value.provesProcessorReceipt, false)
})

test('corpus S6/S7 credit note can reduce or zero Invoice without becoming receipt', () => {
  for (const [id, remaining] of [['in_credit_open', 5_000], ['in_credit_zero', 0]]) {
    const r = obs('Invoice', stripeInvoice(id, { amount_remaining: remaining,
      pre_payment_credit_notes_amount: 5_000, status: remaining ? 'open' : 'paid' }))
    assert.equal(r.interpretation.truthDimension, T.T1_INVOICE_AR_STATE)
    assert.equal(r.interpretation.value.prePaymentCreditNotesAmount, 5_000)
    assert.equal(r.interpretation.value.provesProcessorReceipt, false)
  }
})

test('corpus S8 PaymentIntent requires_action is T2', () => {
  assert.equal(obs('PaymentIntent', paymentIntent('pi_action', { status: 'requires_action' }))
    .interpretation.truthDimension, T.T2_PAYMENT_ATTEMPT_STATE)
})

test('corpus S10 canceled PaymentIntent is T2 with cancellation reason', () => {
  const r = obs('PaymentIntent', paymentIntent('pi_cancel', { status: 'canceled',
    cancellation_reason: 'requested_by_customer' }))
  assert.equal(r.interpretation.truthDimension, T.T2_PAYMENT_ATTEMPT_STATE)
  assert.equal(r.interpretation.value.cancellationReason, 'requested_by_customer')
})

test('corpus S13 open InvoicePayment has no paid allocation amount', () => {
  const r = obs('InvoicePayment', { id: 'inpay_open', livemode: false, invoice: 'in_1',
    status: 'open', amount_requested: 10_000, amount_paid: null, currency: 'usd',
    payment: { type: 'payment_intent', payment_intent: 'pi_open' } })
  assert.equal(r.interpretation.value.status, 'open')
  assert.equal(r.interpretation.value.amountPaid, null)
})

test('corpus S14/S15/S16 InvoicePayment preserves each modern payment reference kind', () => {
  const cases = [
    ['payment_intent', { payment_intent: 'pi_ref' }, 'paymentIntentId', 'pi_ref'],
    ['charge', { charge: 'ch_ref' }, 'chargeId', 'ch_ref'],
    ['payment_record', { payment_record: 'pr_ref' }, 'paymentRecordId', 'pr_ref'],
  ]
  for (const [type, ref, field, expected] of cases) {
    const r = obs('InvoicePayment', { id: `inpay_${type}`, livemode: false, invoice: 'in_1',
      status: 'paid', amount_requested: 100, amount_paid: 100, currency: 'usd',
      payment: { type, ...ref } })
    assert.equal(r.interpretation.value[field], expected)
    assert.equal(r.interpretation.truthDimension, T.T4_PAYMENT_CREDIT_ALLOCATION_STATE)
  }
})

test('corpus S22 amount_overpaid stays Invoice T1 context', () => {
  const r = obs('Invoice', stripeInvoice('in_overpaid', { status: 'paid', amount_remaining: 0,
    amount_paid: 11_000, amount_overpaid: 1_000 }))
  assert.equal(r.interpretation.value.amountOverpaid, 1_000)
  assert.equal(r.interpretation.truthDimension, T.T1_INVOICE_AR_STATE)
})

test('corpus S24 partial refund preserves exact partial amount without AR inference', () => {
  const r = obs('Refund', { id: 're_partial', payment_intent: 'pi_1', charge: 'ch_1',
    amount: 2_500, currency: 'usd', status: 'succeeded', created: 1788541200 })
  assert.equal(r.interpretation.value.amount, 2_500)
  assert.equal(r.interpretation.value.reopensInvoiceAr, false)
})

test('corpus S25/S26 open and resolved disputes remain T3 contest state requiring reread', () => {
  for (const status of ['needs_response', 'won']) {
    const r = obs('Dispute', { id: `dp_${status}`, livemode: false, charge: 'ch_1',
      payment_intent: 'pi_1', amount: 1_000, currency: 'usd', status, balance_transactions: [] })
    assert.equal(r.interpretation.value.status, status)
    assert.ok(r.interpretation.uncertainty.includes('AUTHORITATIVE_INVOICE_AND_PROCESSOR_REFETCH_REQUIRED'))
  }
})

test('corpus S29 payout in_transit remains T5', () => {
  const r = obs('Payout', { id: 'po_transit', livemode: false, amount: 970, currency: 'usd',
    status: 'in_transit', arrival_date: 1788627600 })
  assert.equal(r.interpretation.truthDimension, T.T5_PROCESSOR_FUNDS_SETTLEMENT_STATE)
})

test('corpus S37 event order cannot write or establish current money state', () => {
  const newer = STRIPE.parseChangeEvent({ connection: C, envelope: stripeEvent('charge.updated',
    { id: 'evt_new', created: 1788541200 }) })
  const older = STRIPE.parseChangeEvent({ connection: C, envelope: stripeEvent('charge.updated',
    { id: 'evt_old', created: 1788454800 }) })
  assert.equal(newer.obligation.stateWrittenFromEvent, false)
  assert.equal(older.obligation.stateWrittenFromEvent, false)
})

test('corpus S38 invoice.paid event cannot establish processor receipt', () => {
  const r = STRIPE.parseChangeEvent({ connection: C, envelope: stripeEvent('invoice.paid') })
  assert.equal(r.obligation.stateWrittenFromEvent, false)
  assert.ok(r.obligation.targets.includes('payment_intent'))
})

test('corpus S39 payment_intent.succeeded event still requires reread', () => {
  const r = STRIPE.parseChangeEvent({ connection: C,
    envelope: stripeEvent('payment_intent.succeeded') })
  assert.equal(r.obligation.stateWrittenFromEvent, false)
  assert.ok(r.obligation.targets.includes('payment_intent'))
})

test('corpus S40 payment and settlement currencies are preserved, never equated', () => {
  const receipt = obs('PaymentIntent', paymentIntent('pi_fx', { status: 'succeeded',
    amount_received: 10_000, currency: 'eur' }))
  const settlement = obs('BalanceTransaction', { id: 'txn_fx2', amount: 11_000,
    net: 10_700, fee: 300, currency: 'usd', exchange_rate: 1.1, status: 'available' })
  assert.deepEqual([receipt.interpretation.value.currency, settlement.interpretation.value.currency], ['eur', 'usd'])
  assert.equal(Object.hasOwn(settlement.interpretation.value, 'convertedAmount'), false)
})

test('S-PR1 through S-PR5 preserve modern PaymentRecord provenance and relationships', () => {
  const onStripe = obs('PaymentRecord', { id: 'pr_on', livemode: false, reported_by: 'stripe',
    processor_details: { type: 'stripe' }, amount_guaranteed: { value: 100, currency: 'usd' } })
  const offStripe = obs('PaymentRecord', { id: 'pr_off2', livemode: false, reported_by: 'self',
    processor_details: { type: 'custom' }, amount_guaranteed: { value: 100, currency: 'usd' } })
  const linked = obs('InvoicePayment', { id: 'inpay_pr', livemode: false, invoice: 'in_pr',
    status: 'paid', amount_requested: 100, amount_paid: 100, currency: 'usd',
    payment: { type: 'payment_record', payment_record: 'pr_off2' } })
  const paidInvoice = obs('Invoice', stripeInvoice('in_pr', { status: 'paid', amount_paid: 100,
    amount_paid_off_stripe: 100, amount_remaining: 0 }))
  const refundedOffStripe = obs('PaymentRecord', { id: 'pr_refunded', livemode: false,
    reported_by: 'self', processor_details: { type: 'custom' },
    amount_guaranteed: { value: 100, currency: 'usd' },
    amount_refunded: { value: 100, currency: 'usd' } })
  assert.equal(onStripe.interpretation.truthDimension, T.T3_PAYMENT_RECEIPT_STATE)
  assert.equal(offStripe.interpretation.truthDimension, T.T2_PAYMENT_ATTEMPT_STATE)
  assert.equal(linked.interpretation.value.paymentRecordId, 'pr_off2')
  assert.equal(paidInvoice.interpretation.value.provesProcessorReceipt, false)
  assert.equal(refundedOffStripe.interpretation.truthDimension, T.T2_PAYMENT_ATTEMPT_STATE)
  assert.equal(refundedOffStripe.interpretation.value.amountRefunded.value, 100)
})

test('unknown, partial and stale event snapshots broaden refetch and authenticate nothing', () => {
  for (const event of [
    stripeEvent('future.object.changed', { data: { object: {} } }),
    stripeEvent('invoice.updated', { data: { object: { id: 'in_partial' } } }),
    stripeEvent('invoice.updated', { created: 1, data: { object: { id: 'in_stale' } } }),
  ]) {
    const r = STRIPE.parseChangeEvent({ connection: C, envelope: event })
    assert.equal(r.obligation.stateWrittenFromEvent, false)
    assert.equal(r.obligation.signatureVerifiedByAdapter, false)
  }
})
