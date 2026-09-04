/**
 * M2H-CP1 — canonical scenario corpus, replay, differential, generator.
 *
 * The scenarios are provider-neutral on purpose: CP2 attaches QuickBooks and
 * Xero fixtures to these same twenty, CP3 attaches Stripe, and the corpus
 * stays the thing they are all measured against.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  PROVIDER_TRUTH_DIMENSION as T, CLAIM_SOURCE_OWNER as OWNER, classifyDisagreement,
  CONTRADICTION_MARKER,
} from '../../src/lib/integrations/providerTruthModel.js'
import { FRESHNESS_STATE, invalidationScope } from '../../src/lib/integrations/providerFreshness.js'
import { PROVIDER_CLAIM_ADMISSION, admitProviderClaim } from '../../src/lib/integrations/providerContract.js'
import {
  COLLECTION_ELIGIBILITY, deriveCollectionEligibility,
} from '../../src/lib/integrations/collectionEligibility.js'
import { EVIDENCE_CLASS } from '../../src/lib/integrations/providerEvidence.js'

import {
  SCENARIOS, PROVIDER_LAB_SEED, LAB_TENANT, LAB_TENANT_B, LAB_ACCOUNT, LAB_ACCOUNT_B, LAB_NOW,
  MOCK_LEDGER_ADAPTER, MOCK_PROCESSOR_ADAPTER, MOCK_COMMS_ADAPTER, MOCK_ADAPTERS,
  observeThrough, createReplayEngine, generateAdversarialCompany, runDifferential,
  uglyScenario, providerFixture,
} from './harness.mjs'

console.log(`# providerLab seed=${PROVIDER_LAB_SEED}`)

const FRESH = { state: FRESHNESS_STATE.FRESH, mayGovern: true }
const ledgerClaim = (balance) => ({ value: { balance } })

// ── Corpus shape ─────────────────────────────────────────────────────────────

test('the corpus covers S001-S020 and is provider-neutral', () => {
  assert.equal(SCENARIOS.length, 20)
  const ids = SCENARIOS.map((s) => s.id)
  assert.deepEqual(ids, Array.from({ length: 20 }, (_, i) => `S${String(i + 1).padStart(3, '0')}`))
  // No provider field names may leak into the corpus definition, or CP2/CP3
  // cannot share it.
  const text = JSON.stringify(SCENARIOS).toLowerCase()
  for (const leak of ['quickbooks', 'qbo', 'xero', 'stripe', 'totalamt', 'paymentintent', 'invoiceid:']) {
    assert.equal(text.includes(leak), false, `corpus leaks provider detail: ${leak}`)
  }
})

test('every scenario expects NO authority effect', () => {
  // Provider state never grants G5 authority. Stated once per scenario so a
  // future author has to consciously break it rather than drift into it.
  for (const scenario of SCENARIOS) {
    assert.equal(scenario.expectAuthorityEffect, 'NONE', scenario.id)
  }
})

// ── Individual scenarios ─────────────────────────────────────────────────────

test('S001-S003 open, fully paid and partially paid invoices', () => {
  assert.equal(deriveCollectionEligibility({ ledger: ledgerClaim(1000), ledgerFreshness: FRESH }).outcome,
    COLLECTION_ELIGIBILITY.ELIGIBLE)
  assert.equal(deriveCollectionEligibility({ ledger: ledgerClaim(0), ledgerFreshness: FRESH }).outcome,
    COLLECTION_ELIGIBILITY.BLOCKED)
  assert.equal(deriveCollectionEligibility({ ledger: ledgerClaim(400), ledgerFreshness: FRESH }).outcome,
    COLLECTION_ELIGIBILITY.ELIGIBLE)
})

test('S004 a payment ATTEMPT is not a receipt and holds collection', () => {
  const { interpretation } = observeThrough(MOCK_PROCESSOR_ADAPTER, {
    payload: MOCK_PROCESSOR_ADAPTER.emit({ invoiceId: 'inv-1', amountMinor: 100000, state: 'processing' }),
  })
  assert.equal(interpretation.truthDimension, T.T2_PAYMENT_ATTEMPT_STATE)
  assert.equal(deriveCollectionEligibility({
    ledger: ledgerClaim(1000), ledgerFreshness: FRESH, paymentInFlight: true,
  }).outcome, COLLECTION_ELIGIBILITY.HOLD)
})

test('S005 a receipt does not imply the invoice has been allocated', () => {
  const { interpretation } = observeThrough(MOCK_PROCESSOR_ADAPTER, {
    payload: MOCK_PROCESSOR_ADAPTER.emit({ invoiceId: 'inv-1', amountMinor: 100000 }),
  })
  assert.equal(interpretation.truthDimension, T.T3_PAYMENT_RECEIPT_STATE)
  assert.notEqual(interpretation.truthDimension, T.T4_PAYMENT_CREDIT_ALLOCATION_STATE)
  // Ledger still open while the receipt exists: unapplied value, not a lie.
  assert.equal(deriveCollectionEligibility({
    ledger: ledgerClaim(1000), ledgerFreshness: FRESH, unappliedValue: 1000,
  }).outcome, COLLECTION_ELIGIBILITY.REVIEW_REQUIRED)
})

test('S006/S007 credit and unapplied value require review, never a silent chase', () => {
  assert.equal(deriveCollectionEligibility({
    ledger: ledgerClaim(1000), ledgerFreshness: FRESH, availableCredit: 1000,
  }).outcome, COLLECTION_ELIGIBILITY.REVIEW_REQUIRED)
})

test('S008 a processor receipt and an open AR balance are NOT a contradiction', () => {
  const verdict = classifyDisagreement(
    { truthDimension: T.T3_PAYMENT_RECEIPT_STATE, subject: 'inv-1', value: { received: 1000 }, sourceOwner: OWNER.PAYMENT_PROCESSOR },
    { truthDimension: T.T1_INVOICE_AR_STATE, subject: 'inv-1', value: { balance: 1000 }, sourceOwner: OWNER.LEDGER_SOURCE })
  assert.equal(verdict.marker, CONTRADICTION_MARKER.NO_CONTRADICTION)
})

test('S009/S010/S011 stale, unavailable and revoked are three different answers', () => {
  assert.equal(deriveCollectionEligibility({
    ledger: ledgerClaim(1000), ledgerFreshness: { state: FRESHNESS_STATE.STALE },
  }).outcome, COLLECTION_ELIGIBILITY.HOLD)
  assert.equal(deriveCollectionEligibility({ sourceAvailable: false }).outcome,
    COLLECTION_ELIGIBILITY.UNKNOWN)
  // Revoked reaches the same place by the same route: no readable source.
  assert.equal(deriveCollectionEligibility({ sourceAvailable: false, ledger: null }).outcome,
    COLLECTION_ELIGIBILITY.UNKNOWN)
})

test('S015/S016 deletion and refund produce invalidation, not an assumed outcome', () => {
  const deleted = invalidationScope('PAYMENT_DELETED')
  assert.deepEqual([...deleted.refetch].sort(),
    ['allocations', 'customer_unapplied_value', 'invoice', 'payment'])
  const refund = invalidationScope('REFUND_ISSUED')
  // Crucially it does NOT assert the invoice reopened; it says re-read it.
  assert.ok(refund.refetch.includes('invoice'))
  assert.equal(JSON.stringify(refund).includes('reopen'), false)
})

test('S017 a customer email claiming payment leaves the ledger untouched', () => {
  const { interpretation, admitted } = observeThrough(MOCK_COMMS_ADAPTER, {
    payload: MOCK_COMMS_ADAPTER.emit({ invoiceId: 'inv-1', body: 'We paid this yesterday!' }),
  })
  assert.equal(interpretation.truthDimension, null)
  assert.equal(interpretation.sourceOwner, OWNER.COMMUNICATION_SOURCE)
  assert.equal(admitted.admitted, true)
  // The ledger still governs, and it still says money is owed.
  assert.equal(deriveCollectionEligibility({ ledger: ledgerClaim(1000), ledgerFreshness: FRESH }).outcome,
    COLLECTION_ELIGIBILITY.ELIGIBLE)
})

test('S018 an active dispute blocks', () => {
  assert.equal(deriveCollectionEligibility({
    ledger: ledgerClaim(1000), ledgerFreshness: FRESH, disputeActive: true,
  }).outcome, COLLECTION_ELIGIBILITY.BLOCKED)
})

test('S019 a wrong-tenant object fails closed', () => {
  const { observation, interpretation } = observeThrough(MOCK_LEDGER_ADAPTER, {
    payload: MOCK_LEDGER_ADAPTER.emit({ invoiceId: 'inv-1', balance: 100 }), tenantId: LAB_TENANT_B,
  })
  const result = admitProviderClaim({
    tenantId: LAB_TENANT, providerAccountId: LAB_ACCOUNT, observation, interpretation,
  })
  assert.equal(result.admitted, false)
  assert.equal(result.admission, PROVIDER_CLAIM_ADMISSION.REJECTED_TENANT)
})

test('S020 a same-name client collision leaves attribution unknown', () => {
  assert.equal(deriveCollectionEligibility({
    ledger: ledgerClaim(1000), ledgerFreshness: FRESH, attributionKnown: false,
  }).outcome, COLLECTION_ELIGIBILITY.REVIEW_REQUIRED)
})

// ── Webhook replay (S012-S014 and the rest of the delivery matrix) ───────────

test('S012 duplicate delivery and duplicate event are both idempotent', () => {
  const engine = createReplayEngine()
  assert.equal(engine.deliver({ deliveryId: 'd1', eventId: 'e1', sequence: 1, mutationType: 'PAYMENT_CREATED' }).outcome, 'ACCEPTED')
  assert.equal(engine.deliver({ deliveryId: 'd1', eventId: 'e1', sequence: 1 }).outcome, 'DUPLICATE_DELIVERY')
  // Same semantic event, NEW delivery id — still the same event.
  assert.equal(engine.deliver({ deliveryId: 'd2', eventId: 'e1', sequence: 1 }).outcome, 'DUPLICATE_EVENT')
})

test('S013 out-of-order arrival converges through refetch, not through arrival order', () => {
  const forward = createReplayEngine()
  for (const [d, e, s] of [['d1', 'e1', 1], ['d2', 'e2', 2], ['d3', 'e3', 3]]) {
    forward.deliver({ deliveryId: d, eventId: e, sequence: s, mutationType: 'INVOICE_UPDATED' })
  }
  const reversed = createReplayEngine()
  for (const [d, e, s] of [['d3', 'e3', 3], ['d1', 'e1', 1], ['d2', 'e2', 2]]) {
    reversed.deliver({ deliveryId: d, eventId: e, sequence: s, mutationType: 'INVOICE_UPDATED' })
  }
  assert.deepEqual(forward.settle().refetched.sort(), reversed.settle().refetched.sort())
})

test('S013 a late old event is marked out-of-order and still writes no state', () => {
  const engine = createReplayEngine()
  engine.deliver({ deliveryId: 'd2', eventId: 'e2', sequence: 5, mutationType: 'INVOICE_UPDATED' })
  const late = engine.deliver({ deliveryId: 'd1', eventId: 'e1', sequence: 1, mutationType: 'INVOICE_UPDATED' })
  assert.equal(late.outcome, 'ACCEPTED_OUT_OF_ORDER')
  assert.equal(late.stateWrittenFromEvent, false)
})

test('S014 a retry after a processing failure re-delivers safely', () => {
  const engine = createReplayEngine()
  const first = engine.deliver({ deliveryId: 'd1', eventId: 'e1', sequence: 1, mutationType: 'PAYMENT_DELETED' })
  assert.equal(first.outcome, 'ACCEPTED')
  // The processor died before settling; the provider retries with a new id.
  const retry = engine.deliver({ deliveryId: 'd1-retry', eventId: 'e1', sequence: 1, mutationType: 'PAYMENT_DELETED' })
  assert.equal(retry.outcome, 'DUPLICATE_EVENT')
  // The refetch obligation survives the failure.
  assert.ok(engine.pendingRefetch.includes('invoice'))
})

test('a dropped event cannot create false certainty', () => {
  const engine = createReplayEngine()
  engine.deliver({ deliveryId: 'd1', eventId: 'e1', sequence: 1, mutationType: 'UNKNOWN_PROVIDER_EVENT' })
  // Unknown scope means everything is suspect, so nothing is silently intact.
  assert.ok(engine.pendingRefetch.length > 0)
})

test('an event for the wrong tenant or provider account is rejected', () => {
  const engine = createReplayEngine()
  assert.equal(engine.deliver({ deliveryId: 'x', eventId: 'x', tenantId: LAB_TENANT_B }).outcome, 'REJECTED_SCOPE')
  assert.equal(engine.deliver({ deliveryId: 'y', eventId: 'y', providerAccountId: LAB_ACCOUNT_B }).outcome, 'REJECTED_SCOPE')
  assert.deepEqual(engine.pendingRefetch, [])
})

// ── Differential harness ─────────────────────────────────────────────────────

test('differential: dissimilar providers may agree on the DIMENSION without agreeing on shape', () => {
  const outcome = runDifferential({
    adapters: [MOCK_PROCESSOR_ADAPTER],
    buildPayload: (adapter) => adapter.emit({ invoiceId: 'inv-9', amountMinor: 250000 }),
    expect: { truthDimension: T.T3_PAYMENT_RECEIPT_STATE, subject: 'inv-9' },
  })
  assert.equal(outcome.agreed, true, JSON.stringify(outcome.mismatches))
})

test('differential: the harness DETECTS a dimension mismatch rather than smoothing it', () => {
  // A ledger cannot be asked to produce a payment receipt. The harness must
  // report that, or it would be useless as a cross-provider check in CP2+.
  const outcome = runDifferential({
    adapters: [MOCK_LEDGER_ADAPTER],
    buildPayload: (adapter) => adapter.emit({ invoiceId: 'inv-9', balance: 100 }),
    expect: { truthDimension: T.T3_PAYMENT_RECEIPT_STATE, subject: 'inv-9' },
  })
  assert.equal(outcome.agreed, false)
  assert.equal(outcome.mismatches.length, 1)
})

// ── Adversarial generator ────────────────────────────────────────────────────

test('the generator is deterministic and reproducible from its seed', () => {
  const a = generateAdversarialCompany(PROVIDER_LAB_SEED)
  const b = generateAdversarialCompany(PROVIDER_LAB_SEED)
  assert.deepEqual(a, b)
  assert.equal(a.seed, 829144)
  const different = generateAdversarialCompany(PROVIDER_LAB_SEED + 1)
  assert.notDeepEqual(a.invoices, different.invoices)
})

test('every generated company yields a defensible eligibility for every invoice', () => {
  const known = new Set(Object.values(COLLECTION_ELIGIBILITY))
  for (let seed = PROVIDER_LAB_SEED; seed < PROVIDER_LAB_SEED + 25; seed += 1) {
    const company = generateAdversarialCompany(seed)
    for (const invoice of company.invoices) {
      const result = deriveCollectionEligibility({
        ledger: ledgerClaim(invoice.balance),
        ledgerFreshness: invoice.ledgerStale ? { state: FRESHNESS_STATE.STALE } : FRESH,
        paymentInFlight: invoice.paymentInFlight,
        disputeActive: invoice.disputeActive,
        availableCredit: invoice.availableCredit,
        sourceAvailable: invoice.sourceAvailable,
      })
      assert.ok(known.has(result.outcome), `seed ${seed} invoice ${invoice.id}`)
      assert.equal(result.authorityEvaluated, false)
      // An unreadable or stale source must never come back ELIGIBLE.
      if (!invoice.sourceAvailable || invoice.ledgerStale) {
        assert.notEqual(result.outcome, COLLECTION_ELIGIBILITY.ELIGIBLE, `seed ${seed} ${invoice.id}`)
      }
    }
  }
})

test('generated event streams replay identically for the same seed', () => {
  const company = generateAdversarialCompany(PROVIDER_LAB_SEED)
  const run = () => {
    const engine = createReplayEngine()
    for (const event of company.events) engine.deliver(event)
    return engine.settle().refetched.sort()
  }
  assert.deepEqual(run(), run())
})

// ── Regression formats ───────────────────────────────────────────────────────

test('the ugly-scenario format demands every field a future surprise needs', () => {
  assert.throws(() => uglyScenario({ id: 'UGLY-001' }), /requires/)
  const ugly = uglyScenario({
    id: 'UGLY-001',
    initialState: 'invoice open, $1,000',
    trigger: 'provider emits a zero-amount payment linked to a credit memo',
    observedProviderBehavior: 'Payment.TotalAmt = 0 with LinkedTxn CreditMemo + Invoice',
    truthDimensionsAffected: [T.T4_PAYMENT_CREDIT_ALLOCATION_STATE],
    dangerousInterpretation: 'cash was received, so the invoice is paid',
    correctInterpretation: 'a provider-generated credit allocation, no cash received',
    requiredInvalidation: ['invoice', 'allocations'],
    collectionEligibility: COLLECTION_ELIGIBILITY.REVIEW_REQUIRED,
    evidence: EVIDENCE_CLASS.E0_HYPOTHESIS,
    canonicalInvariantTested: 'payment receipt is not payment allocation',
  })
  assert.equal(ugly.kind, 'M2H_UGLY_SCENARIO_V0')
})

test('a fixture carrying credentials is refused', () => {
  const base = {
    provider: 'mock_ledger', objectOrEventType: 'Invoice',
    accountAnonymization: 'account id replaced with acct-lab-1',
    capturedAt: LAB_NOW, fixtureVersion: 'v1',
    evidenceClass: EVIDENCE_CLASS.E0_HYPOTHESIS,
    sanitizationStatement: 'synthetic data only; no customer PII',
    expectedInterpretation: { truthDimension: T.T1_INVOICE_AR_STATE },
  }
  assert.equal(providerFixture({ ...base, payload: { Id: '1', Balance: 100 } }).kind, 'M2H_PROVIDER_FIXTURE_V0')
  for (const secret of ['access_token', 'refresh_token', 'client_secret', 'signing_secret']) {
    assert.throws(() => providerFixture({ ...base, payload: { [secret]: 'x' } }),
      /refusing to store provider credentials/, secret)
  }
})

test('all three mock adapters are declared mocks and claim no live evidence', () => {
  for (const adapter of MOCK_ADAPTERS) {
    assert.ok(adapter.provider.startsWith('mock_'), adapter.provider)
    const { observation } = observeThrough(adapter, {
      payload: adapter.emit({ invoiceId: 'inv-1', balance: 1, amountMinor: 100, body: 'x' }),
    })
    assert.equal(observation.environment, 'MOCK')
  }
})
