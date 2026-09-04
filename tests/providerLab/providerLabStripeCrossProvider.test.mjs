import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyDisagreement, CONTRADICTION_MARKER,
  PROVIDER_TRUTH_DIMENSION as T } from '../../src/lib/integrations/providerTruthModel.js'
import { EVIDENCE_CLASS, OBSERVATION_ENVIRONMENT, recordEvidence,
  composeEvidence } from '../../src/lib/integrations/providerEvidence.js'
import { describeProviderCapability, CAPABILITY_VALUE,
  capabilityGrantsAuthority } from '../../src/lib/integrations/providerCapability.js'
import { stripeAdapter as STRIPE, STRIPE_PROVIDER } from '../../src/lib/providerAdapters/payments/stripeAdapter.js'
import { quickBooksOnlineAdapter as QBO, QUICKBOOKS_ONLINE_PROVIDER } from '../../src/lib/providerAdapters/accounting/quickbooksOnlineAdapter.js'
import { xeroAccountingAdapter as XERO, XERO_ACCOUNTING_PROVIDER } from '../../src/lib/providerAdapters/accounting/xeroAccountingAdapter.js'
import { observeAccounting, qboInvoice, xeroInvoice } from './accountingHarness.mjs'
import { observeStripe, stripeInvoice, paymentIntent } from './stripeHarness.mjs'
import { uglyScenario } from './harness.mjs'

const S = { tenantId: 'dw-a', provider: STRIPE_PROVIDER, providerAccountId: 'acct_a', livemode: false }
const Q = { tenantId: 'dw-a', provider: QUICKBOOKS_ONLINE_PROVIDER, providerAccountId: 'realm-a' }
const X = { tenantId: 'dw-a', provider: XERO_ACCOUNTING_PROVIDER, providerAccountId: 'org-a' }

test('Stripe, QBO and Xero invoice shapes can independently express T1', () => {
  const results = [
    observeStripe(STRIPE, { connection: S, objectType: 'Invoice', payload: stripeInvoice('invoice-a') }),
    observeAccounting(QBO, { connection: Q, objectType: 'Invoice', payload: qboInvoice('invoice-a') }),
    observeAccounting(XERO, { connection: X, objectType: 'Invoice', payload: xeroInvoice('invoice-a') }),
  ]
  assert.ok(results.every((r) => r.interpretation.truthDimension === T.T1_INVOICE_AR_STATE))
  assert.ok(results.every((r) => r.admitted.admitted))
})

test('Stripe receipt and accounting allocation are not a fake conflict', () => {
  const stripe = observeStripe(STRIPE, { connection: S, objectType: 'PaymentIntent',
    payload: paymentIntent('pi_1', { status: 'succeeded', amount_received: 10_000 }) })
  const qbo = observeAccounting(QBO, { connection: Q, objectType: 'Payment', payload: {
    Id: 'q-pay', TotalAmt: 10_000, CustomerRef: { value: 'q-customer' },
    Line: [{ Amount: 10_000, LinkedTxn: [{ TxnId: stripe.interpretation.subject, TxnType: 'Invoice' }] }],
    MetaData: { LastUpdatedTime: '2026-09-04T18:00:00Z' },
  } })
  assert.equal(classifyDisagreement(stripe.interpretation, qbo.interpretation).marker,
    CONTRADICTION_MARKER.NO_CONTRADICTION)
})

test('invoice allocation and processor receipt remain distinct across Stripe objects', () => {
  const receipt = observeStripe(STRIPE, { connection: S, objectType: 'PaymentIntent',
    payload: paymentIntent('pi_1', { status: 'succeeded', amount_received: 10_000 }) })
  const allocation = observeStripe(STRIPE, { connection: S, objectType: 'InvoicePayment', payload: {
    id: 'inpay_1', livemode: false, invoice: 'in_1', status: 'paid', amount_requested: 10_000,
    amount_paid: 10_000, currency: 'usd', payment: { type: 'payment_intent', payment_intent: 'pi_1' },
  } })
  assert.deepEqual([receipt.interpretation.truthDimension, allocation.interpretation.truthDimension],
    [T.T3_PAYMENT_RECEIPT_STATE, T.T4_PAYMENT_CREDIT_ALLOCATION_STATE])
})

test('multi-provider E7 requires support-bearing records for the same proposition', () => {
  const propositionKey = 'invoice_outstanding_balance_represents_ar_state'
  const stripe = recordEvidence({ evidenceClass: EVIDENCE_CLASS.E2_DOC_CONFIRMED,
    environment: OBSERVATION_ENVIRONMENT.FIXTURE_REPLAY, provider: STRIPE_PROVIDER,
    propositionKey, refs: ['https://docs.stripe.com/api/invoices/object'] })
  const qbo = recordEvidence({ evidenceClass: EVIDENCE_CLASS.E2_DOC_CONFIRMED,
    environment: OBSERVATION_ENVIRONMENT.FIXTURE_REPLAY, provider: QUICKBOOKS_ONLINE_PROVIDER,
    propositionKey, refs: ['https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/invoice'] })
  const e7 = composeEvidence({ evidenceClass: EVIDENCE_CLASS.E7_MULTI_PROVIDER_SUPPORTED,
    components: [stripe, qbo] })
  assert.deepEqual(e7.providers, [QUICKBOOKS_ONLINE_PROVIDER, STRIPE_PROVIDER])
})

test('Stripe fixture replay cannot mint sandbox evidence', () => {
  assert.throws(() => recordEvidence({ evidenceClass: EVIDENCE_CLASS.E4_SANDBOX_OBSERVED,
    environment: OBSERVATION_ENVIRONMENT.FIXTURE_REPLAY, provider: STRIPE_PROVIDER,
    propositionKey: 'processor_success_represents_payment_receipt', captureId: 'fixture' }),
  /mock cannot be the evidence/)
})

test('Stripe provider capability cannot grant G5 authority or execution', () => {
  const capability = describeProviderCapability({ provider: STRIPE_PROVIDER, operation: 'create_refund',
    canTechnicallyWrite: CAPABILITY_VALUE.YES, supportedInProviderApi: CAPABILITY_VALUE.YES,
    supportedByDuewatchAdapter: CAPABILITY_VALUE.NO, allowedByCurrentScopes: CAPABILITY_VALUE.YES })
  assert.equal(capability.supportedByDuewatchAdapter, CAPABILITY_VALUE.NO)
  assert.equal(capabilityGrantsAuthority(), false)
})

test('Stripe surprises are permanent complete ugly-scenario records', () => {
  const rows = [
    ['UGLY-STRIPE-PAID-OUT-OF-BAND', 'Invoice paid outside Stripe is not processor receipt', ['INVOICE_AR_STATE']],
    ['UGLY-STRIPE-PAYMENT-RECORD', 'Self-reported custom payment record resembles receipt', ['PAYMENT_ATTEMPT_STATE']],
    ['UGLY-STRIPE-PAYOUT-PAID', 'Paid payout can later fail', ['PROCESSOR_FUNDS_SETTLEMENT_STATE']],
    ['UGLY-STRIPE-EMBEDDED-PAYMENTS', 'Invoice embeds only the first payments page', ['PAYMENT_CREDIT_ALLOCATION_STATE']],
  ].map(([id, behavior, dimensions]) => uglyScenario({ id, initialState: 'authoritative read pending',
    trigger: 'sanitized provider fixture replay', observedProviderBehavior: behavior,
    dangerousInterpretation: 'cash is final and safe to collect',
    correctInterpretation: 'preserve exact dimension and require authoritative scoped reread',
    truthDimensionsAffected: dimensions, requiredInvalidation: ['invoice', 'payments'],
    collectionEligibility: 'REVIEW_REQUIRED', evidence: 'E1/E2 docs plus fixture; no sandbox claim',
    canonicalInvariantTested: 'provider shape cannot collapse dimensions or grant authority' }))
  assert.equal(rows.length, 4)
  assert.ok(rows.every((row) => row.kind === 'M2H_UGLY_SCENARIO_V0'))
})
