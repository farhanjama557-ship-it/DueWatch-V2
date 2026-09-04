import test from 'node:test'
import assert from 'node:assert/strict'
import { PROVIDER_TRUTH_DIMENSION as T } from '../../src/lib/integrations/providerTruthModel.js'
import { stripeAdapter as STRIPE, STRIPE_PROVIDER, createStripeSyncState } from '../../src/lib/providerAdapters/payments/stripeAdapter.js'
import { observeStripe, stripeInvoice, paymentIntent, stripeEvent, CP3_NOW } from './stripeHarness.mjs'

const C = { tenantId: 'dw-a', provider: STRIPE_PROVIDER, providerAccountId: 'acct_a', livemode: false }
const observe = (objectType, payload, extras = {}) => observeStripe(STRIPE,
  { connection: C, objectType, payload, ...extras })

const mutants = [
  ['SM01 Invoice status paid -> T3', () => observe('Invoice', stripeInvoice('in_paid', { status: 'paid' })).interpretation.truthDimension !== T.T3_PAYMENT_RECEIPT_STATE],
  ['SM02 PaymentIntent processing -> T3', () => observe('PaymentIntent', paymentIntent('pi_processing', { status: 'processing' })).interpretation.truthDimension !== T.T3_PAYMENT_RECEIPT_STATE],
  ['SM03 Charge paid authorization -> T3', () => observe('Charge', { id: 'ch_auth', livemode: false, paid: true, captured: false, amount: 1, currency: 'usd' }).interpretation.truthDimension === T.T2_PAYMENT_ATTEMPT_STATE],
  ['SM04 double-count Charge and PaymentIntent', () => observe('Charge', { id: 'ch_1', livemode: false, payment_intent: 'pi_1', paid: true, captured: true, amount: 1, currency: 'usd' }).interpretation.subject === observe('PaymentIntent', paymentIntent('pi_1', { status: 'succeeded' })).interpretation.subject],
  ['SM05 InvoicePayment -> T3', () => observe('InvoicePayment', { id: 'inpay', livemode: false, invoice: 'in', status: 'paid', amount_requested: 1, amount_paid: 1, currency: 'usd', payment: {} }).interpretation.truthDimension === T.T4_PAYMENT_CREDIT_ALLOCATION_STATE],
  ['SM06 paid out of band -> processor receipt', () => observe('Invoice', stripeInvoice('in_oob', { amount_paid_off_stripe: 1 })).interpretation.value.provesProcessorReceipt === false],
  ['SM07 self-reported PaymentRecord -> T3', () => observe('PaymentRecord', { id: 'pr', livemode: false, reported_by: 'self', processor_details: { type: 'custom' }, amount_guaranteed: { value: 1, currency: 'usd' } }).interpretation.truthDimension === T.T2_PAYMENT_ATTEMPT_STATE],
  ['SM08 custom processor -> Stripe receipt', () => observe('PaymentRecord', { id: 'pr', livemode: false, reported_by: 'stripe', processor_details: { type: 'custom' }, amount_guaranteed: { value: 1, currency: 'usd' } }).interpretation.value.stripeProcessorReceiptEstablished === false],
  ['SM09 PaymentAttemptRecord guaranteed -> T3', () => observe('PaymentAttemptRecord', { id: 'par', payment_record: 'pr', livemode: false, reported_by: 'self', processor_details: { type: 'custom' }, amount_guaranteed: { value: 1, currency: 'usd' } }).interpretation.truthDimension === T.T2_PAYMENT_ATTEMPT_STATE],
  ['SM10 CreditNote -> T3', () => observe('CreditNote', { id: 'cn', livemode: false, invoice: 'in', amount: 1, currency: 'usd' }).interpretation.truthDimension === T.T4_PAYMENT_CREDIT_ALLOCATION_STATE],
  ['SM11 customer credit disappears', () => observe('CustomerBalanceTransaction', { id: 'cb', customer: 'cus', amount: -9, ending_balance: -9, currency: 'usd' }).interpretation.value.amount === -9],
  ['SM12 test/live collision', () => STRIPE.createObservationInput({ connection: C, objectType: 'Invoice', payload: stripeInvoice('same'), observedAt: CP3_NOW }).externalObjectId.includes(':test:')],
  ['SM13 object livemode ignored', () => { try { STRIPE.createObservationInput({ connection: C, objectType: 'Invoice', payload: stripeInvoice('in', { livemode: true }), observedAt: CP3_NOW }); return false } catch { return true } }],
  ['SM14 event account ignored', () => STRIPE.parseChangeEvent({ connection: C, envelope: stripeEvent('invoice.updated', { account: 'acct_b' }) }).accepted === false],
  ['SM15 event livemode ignored', () => STRIPE.parseChangeEvent({ connection: C, envelope: stripeEvent('invoice.updated', { livemode: true }) }).accepted === false],
  ['SM16 event writes truth', () => STRIPE.parseChangeEvent({ connection: C, envelope: stripeEvent('invoice.paid') }).obligation.stateWrittenFromEvent === false],
  ['SM17 event drops authoritative refetch', () => STRIPE.parseChangeEvent({ connection: C, envelope: stripeEvent('charge.refunded') }).obligation.targets.includes('invoice')],
  ['SM18 incomplete page accepted', () => createStripeSyncState(C).ingestPage({ connection: C, hasMore: true }).syncComplete === false],
  ['SM19 failed page becomes empty complete', () => { const s = createStripeSyncState(C); s.ingestPage({ connection: C, failed: true }); s.ingestPage({ connection: C, hasMore: false }); return s.snapshot.syncComplete === false }],
  ['SM20 older page wins', () => { const s = createStripeSyncState(C); s.ingestPage({ connection: C, hasMore: true, items: [{ objectType: 'Invoice', externalObjectId: 'in', versionAt: CP3_NOW, payload: 2 }] }); s.ingestPage({ connection: C, hasMore: false, items: [{ objectType: 'Invoice', externalObjectId: 'in', versionAt: '2020-01-01T00:00:00Z', payload: 1 }] }); return s.snapshot.items[0].payload === 2 }],
  ['SM21 BalanceTransaction -> T6', () => observe('BalanceTransaction', { id: 'txn', amount: 1, currency: 'usd', status: 'available' }).interpretation.truthDimension === T.T5_PROCESSOR_FUNDS_SETTLEMENT_STATE],
  ['SM22 Payout paid -> T6', () => observe('Payout', { id: 'po', livemode: false, amount: 1, currency: 'usd', status: 'paid' }).interpretation.value.establishesBankLedgerReconciliation === false],
  ['SM23 provider capability -> authority', () => STRIPE.supportedByDuewatchAdapter.write === 'NO'],
]

for (const [name, killed] of mutants) test(`${name} is killed`, () => assert.equal(killed(), true))

test('CP3 semantic mutation inventory has 23 unique observable targets and no survivors', () => {
  assert.equal(mutants.length, 23)
  assert.equal(new Set(mutants.map(([name]) => name)).size, 23)
})
