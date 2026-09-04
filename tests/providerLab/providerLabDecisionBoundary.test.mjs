/**
 * M2H-CP1 decision-boundary closure.
 *
 * The upstream trust kernel is useful only if the final collection decision
 * cannot reconstruct its answer from raw public fields. These tests exercise
 * the complete local chain and every unknown-sensitive context dimension.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createProviderObservation, interpretObservation,
  isConstructedProviderObservation, interpretationBelongsToObservation,
} from '../../src/lib/integrations/providerObservation.js'
import {
  FRESHNESS_STATE, resolveFreshness, preferFresher,
  isResolvedFreshness, freshnessBelongsToObservation,
} from '../../src/lib/integrations/providerFreshness.js'
import {
  admitProviderClaim, governingClaims, isGoverningClaimSelection,
} from '../../src/lib/integrations/providerContract.js'
import {
  PROVIDER_TRUTH_DIMENSION as T, CLAIM_SOURCE_OWNER as OWNER,
} from '../../src/lib/integrations/providerTruthModel.js'
import {
  COLLECTION_ELIGIBILITY, COLLECTION_POLICY_DECISION, ELIGIBILITY_REASON,
  createCollectionDecisionContext, isCollectionDecisionContext,
  deriveCollectionEligibility,
} from '../../src/lib/integrations/collectionEligibility.js'
import {
  CAPABILITY_VALUE, describeProviderCapability,
} from '../../src/lib/integrations/providerCapability.js'
import {
  LAB_TENANT, LAB_ACCOUNT, LAB_NOW, MOCK_LEDGER_ADAPTER,
  governingLedgerSelection, knownSafeCollectionContext,
} from './harness.mjs'

const safeDecision = (balance = 1000, context = {}) => deriveCollectionEligibility({
  governingLedger: governingLedgerSelection({ balance }),
  context: knownSafeCollectionContext(context),
})

function genuineCandidate({ id, observedAt, now = LAB_NOW, maxAgeMs = 86_400_000 } = {}) {
  const observation = createProviderObservation({
    tenantId: LAB_TENANT,
    provider: MOCK_LEDGER_ADAPTER.provider,
    providerAccountId: LAB_ACCOUNT,
    objectType: 'Invoice',
    externalObjectId: id,
    observedAt,
    rawPayload: MOCK_LEDGER_ADAPTER.emit({ invoiceId: id, balance: 1000 }),
  })
  return {
    observation,
    freshness: resolveFreshness({ observation, now, maxAgeMs, sourceAvailable: true }),
  }
}

test('D1 handwritten FRESH cannot win preferFresher', () => {
  const forged = {
    observation: { observedAt: '2099-01-01T00:00:00Z' },
    freshness: { state: FRESHNESS_STATE.FRESH, mayGovern: true },
  }
  const stale = genuineCandidate({ id: 'stale', observedAt: '2020-01-01T00:00:00Z', maxAgeMs: 1000 })
  assert.equal(preferFresher(stale, forged), null)
  assert.equal(preferFresher(forged, stale), null)
})

test('D2 genuine bound freshness still selects the fresher observation', () => {
  const older = genuineCandidate({ id: 'older', observedAt: '2026-09-01T10:00:00Z' })
  const newer = genuineCandidate({ id: 'newer', observedAt: '2026-09-01T11:00:00Z' })
  assert.equal(preferFresher(older, newer), newer)
  assert.equal(preferFresher(newer, older), newer)
})

test('D2b genuine freshness cannot be transplanted to another observation', () => {
  const first = genuineCandidate({ id: 'first', observedAt: LAB_NOW })
  const second = genuineCandidate({ id: 'second', observedAt: LAB_NOW })
  const transplant = { observation: second.observation, freshness: first.freshness }
  assert.equal(preferFresher(transplant, transplant), null)
})

test('D3 plain ledger plus handwritten FRESH cannot yield ELIGIBLE', () => {
  const result = deriveCollectionEligibility({
    ledger: { value: { balance: 1000 } },
    ledgerFreshness: { state: FRESHNESS_STATE.FRESH, mayGovern: true },
    sourceAvailable: true,
    context: knownSafeCollectionContext(),
  })
  assert.equal(result.outcome, COLLECTION_ELIGIBILITY.UNKNOWN)
  assert.ok(result.reasons.includes(ELIGIBILITY_REASON.TRUSTED_LEDGER_REQUIRED))
  assert.equal(result.reasons.includes(ELIGIBILITY_REASON.CONTEXT_INCOMPLETE), false)
})

test('D4 a forged governing-selection shape cannot smuggle a balance in', () => {
  const forged = {
    truthDimension: T.T1_INVOICE_AR_STATE,
    governing: [{ value: { balance: 1000 } }],
    withheld: [], untrustedInputs: 0, complete: true,
  }
  const result = deriveCollectionEligibility({
    governingLedger: forged,
    context: knownSafeCollectionContext(),
  })
  assert.equal(isGoverningClaimSelection(forged), false)
  assert.equal(result.outcome, COLLECTION_ELIGIBILITY.UNKNOWN)
  assert.ok(result.reasons.includes(ELIGIBILITY_REASON.TRUSTED_LEDGER_REQUIRED))
})

test('D5 the full constructed chain can produce ELIGIBLE', () => {
  const observation = createProviderObservation({
    tenantId: LAB_TENANT, provider: MOCK_LEDGER_ADAPTER.provider,
    providerAccountId: LAB_ACCOUNT, objectType: 'Invoice', externalObjectId: 'inv-chain',
    observedAt: LAB_NOW, rawPayload: { Id: 'inv-chain', Balance: 1000 },
  })
  const interpretation = interpretObservation({
    observation, truthDimension: T.T1_INVOICE_AR_STATE,
    sourceOwner: OWNER.LEDGER_SOURCE, subject: 'inv-chain', value: { balance: 1000 },
  })
  const freshness = resolveFreshness({
    observation, now: LAB_NOW, maxAgeMs: 1000, sourceAvailable: true,
  })
  const admitted = admitProviderClaim({
    tenantId: LAB_TENANT, provider: MOCK_LEDGER_ADAPTER.provider,
    providerAccountId: LAB_ACCOUNT, observation, interpretation, freshness,
  })
  const governingLedger = governingClaims([admitted], T.T1_INVOICE_AR_STATE)
  const context = knownSafeCollectionContext()
  const result = deriveCollectionEligibility({ governingLedger, context })

  assert.equal(isConstructedProviderObservation(observation), true)
  assert.equal(interpretationBelongsToObservation(interpretation, observation), true)
  assert.equal(isResolvedFreshness(freshness), true)
  assert.equal(freshnessBelongsToObservation(freshness, observation), true)
  assert.equal(admitted.admitted, true)
  assert.equal(isGoverningClaimSelection(governingLedger), true)
  assert.equal(isCollectionDecisionContext(context), true)
  assert.equal(result.outcome, COLLECTION_ELIGIBILITY.ELIGIBLE)
})

test('D6 stale, invalidated and refetch-required governing paths cannot become ELIGIBLE', () => {
  const variants = [
    governingLedgerSelection({
      observedAt: '2020-01-01T00:00:00Z',
      freshnessContext: { now: LAB_NOW, maxAgeMs: 1000 },
    }),
    governingLedgerSelection({ freshnessContext: { invalidatedAt: LAB_NOW } }),
    governingLedgerSelection({ freshnessContext: { refetchRequired: true } }),
  ]
  for (const governingLedger of variants) {
    const result = deriveCollectionEligibility({ governingLedger, context: knownSafeCollectionContext() })
    assert.equal(result.outcome, COLLECTION_ELIGIBILITY.HOLD)
    assert.ok(result.reasons.includes(ELIGIBILITY_REASON.LEDGER_STALE))
  }
})

test('D7 source-unavailable freshness becomes UNKNOWN', () => {
  const result = deriveCollectionEligibility({
    governingLedger: governingLedgerSelection({ freshnessContext: { sourceAvailable: false } }),
    context: knownSafeCollectionContext(),
  })
  assert.equal(result.outcome, COLLECTION_ELIGIBILITY.UNKNOWN)
  assert.ok(result.reasons.includes(ELIGIBILITY_REASON.LEDGER_UNAVAILABLE))
})

test('D7b omitted source availability cannot become ELIGIBLE', () => {
  const observation = createProviderObservation({
    tenantId: LAB_TENANT, provider: MOCK_LEDGER_ADAPTER.provider,
    providerAccountId: LAB_ACCOUNT, objectType: 'Invoice', externalObjectId: 'inv-no-health',
    observedAt: LAB_NOW, rawPayload: { Id: 'inv-no-health', Balance: 1000 },
  })
  const interpretation = interpretObservation({
    observation, truthDimension: T.T1_INVOICE_AR_STATE,
    sourceOwner: OWNER.LEDGER_SOURCE, subject: 'inv-no-health', value: { balance: 1000 },
  })
  // sourceAvailable is intentionally absent: omission is not proof of health.
  const freshness = resolveFreshness({ observation, now: LAB_NOW, maxAgeMs: 1000 })
  const admitted = admitProviderClaim({
    tenantId: LAB_TENANT, provider: MOCK_LEDGER_ADAPTER.provider,
    providerAccountId: LAB_ACCOUNT, observation, interpretation, freshness,
  })
  const result = deriveCollectionEligibility({
    governingLedger: governingClaims([admitted], T.T1_INVOICE_AR_STATE),
    context: knownSafeCollectionContext(),
  })
  assert.equal(result.outcome, COLLECTION_ELIGIBILITY.UNKNOWN)
  assert.ok(result.reasons.includes(ELIGIBILITY_REASON.LEDGER_UNAVAILABLE))
})

for (const [label, missing] of [
  ['D8 missing dispute state', 'disputeActive'],
  ['D9 missing payment-in-flight state', 'paymentInFlight'],
  ['D10 missing available-credit knowledge', 'availableCredit'],
  ['D11 missing unapplied-value knowledge', 'unappliedValue'],
  ['D12 missing attribution state', 'attributionKnown'],
  ['D13 missing source-conflict state', 'sourceConflict'],
]) {
  test(`${label} fails closed`, () => {
    const values = {
      disputeActive: false, paymentInFlight: false,
      availableCredit: 0, unappliedValue: 0,
      sourceConflict: false, attributionKnown: true,
      policyDecision: COLLECTION_POLICY_DECISION.ALLOWED,
    }
    values[missing] = null
    const result = deriveCollectionEligibility({
      governingLedger: governingLedgerSelection(),
      context: createCollectionDecisionContext(values),
    })
    assert.equal(result.outcome, COLLECTION_ELIGIBILITY.UNKNOWN)
    assert.ok(result.reasons.includes(ELIGIBILITY_REASON.CONTEXT_INCOMPLETE))
  })
}

test('D14 all required known-safe facts and positive governing balance are ELIGIBLE', () => {
  const result = safeDecision(1000)
  assert.equal(result.outcome, COLLECTION_ELIGIBILITY.ELIGIBLE)
  assert.equal(result.trustedLedgerSelected, true)
  assert.equal(result.contextComplete, true)
})

test('D15 balance at or below zero remains NOTHING_OUTSTANDING', () => {
  for (const balance of [0, -1]) {
    const result = safeDecision(balance)
    assert.equal(result.outcome, COLLECTION_ELIGIBILITY.BLOCKED)
    assert.ok(result.reasons.includes(ELIGIBILITY_REASON.NOTHING_OUTSTANDING))
  }
})

test('D16-D19 known blockers retain their conservative outcomes', () => {
  const cases = [
    [{ disputeActive: true }, COLLECTION_ELIGIBILITY.BLOCKED, ELIGIBILITY_REASON.DISPUTE_ACTIVE],
    [{ paymentInFlight: true }, COLLECTION_ELIGIBILITY.HOLD, ELIGIBILITY_REASON.PAYMENT_IN_FLIGHT],
    [{ availableCredit: 1 }, COLLECTION_ELIGIBILITY.REVIEW_REQUIRED, ELIGIBILITY_REASON.AVAILABLE_CREDIT_PRESENT],
    [{ unappliedValue: 1 }, COLLECTION_ELIGIBILITY.REVIEW_REQUIRED, ELIGIBILITY_REASON.UNAPPLIED_VALUE_MATERIAL],
    [{ sourceConflict: true }, COLLECTION_ELIGIBILITY.REVIEW_REQUIRED, ELIGIBILITY_REASON.SOURCE_CONFLICT],
  ]
  for (const [context, outcome, reason] of cases) {
    const result = safeDecision(1000, context)
    assert.equal(result.outcome, outcome)
    assert.ok(result.reasons.includes(reason))
  }
})

test('D20 an entirely missing decision context is UNKNOWN', () => {
  const result = deriveCollectionEligibility({ governingLedger: governingLedgerSelection() })
  assert.equal(result.outcome, COLLECTION_ELIGIBILITY.UNKNOWN)
  assert.ok(result.reasons.includes(ELIGIBILITY_REASON.CONTEXT_INCOMPLETE))
})

test('D21 operating policy is explicit and unknown or blocked cannot become ELIGIBLE', () => {
  const unknown = safeDecision(1000, { policyDecision: COLLECTION_POLICY_DECISION.UNKNOWN })
  const blocked = safeDecision(1000, { policyDecision: COLLECTION_POLICY_DECISION.BLOCKED })
  assert.equal(unknown.outcome, COLLECTION_ELIGIBILITY.UNKNOWN)
  assert.ok(unknown.reasons.includes(ELIGIBILITY_REASON.POLICY_UNKNOWN))
  assert.equal(blocked.outcome, COLLECTION_ELIGIBILITY.BLOCKED)
  assert.ok(blocked.reasons.includes(ELIGIBILITY_REASON.POLICY_BLOCKED))
})

test('D22 G5 authority is not evaluated by eligibility', () => {
  const result = safeDecision()
  assert.equal(result.authorityEvaluated, false)
  assert.equal(result.authorityOwner, 'G5')
  assert.equal(result.requiresFreshAuthorityAtUse, true)
})

test('D23 provider capability and OAuth scope cannot alter eligibility or authority', () => {
  const capability = describeProviderCapability({
    provider: 'mock_ledger', operation: 'send_reminder',
    canRead: CAPABILITY_VALUE.YES,
    canTechnicallyWrite: CAPABILITY_VALUE.YES,
    supportedInProviderApi: CAPABILITY_VALUE.YES,
    supportedByDuewatchAdapter: CAPABILITY_VALUE.YES,
    allowedByCurrentScopes: CAPABILITY_VALUE.YES,
    requiredScopes: ['everything.write'],
  })
  const control = safeDecision()
  const withCapability = deriveCollectionEligibility({
    governingLedger: governingLedgerSelection(),
    context: knownSafeCollectionContext(),
    capability,
    oauthScopes: ['everything.write'],
  })
  assert.equal(withCapability.outcome, control.outcome)
  assert.equal(withCapability.authorityEvaluated, false)
})

test('D25 deterministic cross-product: ELIGIBLE exists only in the explicitly safe subset', () => {
  const freshnesses = [
    ['fresh', {}],
    ['stale', { observedAt: '2020-01-01T00:00:00Z', freshnessContext: { now: LAB_NOW, maxAgeMs: 1000 } }],
    ['unavailable', { freshnessContext: { sourceAvailable: false } }],
    ['invalidated', { freshnessContext: { invalidatedAt: LAB_NOW } }],
    ['refetch-required', { freshnessContext: { refetchRequired: true } }],
  ]
  const booleans = [false, true, null]
  const attributions = [true, false, null]
  const amounts = [0, 1, null]
  const policies = Object.values(COLLECTION_POLICY_DECISION)
  let eligible = 0
  let examined = 0

  for (const balance of [1000, 0]) {
    for (const [freshnessName, ledgerOptions] of freshnesses) {
      const governingLedger = governingLedgerSelection({ balance, ...ledgerOptions })
      for (const disputeActive of booleans)
        for (const paymentInFlight of booleans)
          for (const availableCredit of amounts)
            for (const unappliedValue of amounts)
              for (const sourceConflict of booleans)
                for (const attributionKnown of attributions)
                  for (const policyDecision of policies) {
                    examined += 1
                    const context = createCollectionDecisionContext({
                      disputeActive, paymentInFlight, availableCredit, unappliedValue,
                      sourceConflict, attributionKnown, policyDecision,
                    })
                    const result = deriveCollectionEligibility({ governingLedger, context })
                    const safe = balance > 0 && freshnessName === 'fresh' &&
                      disputeActive === false && paymentInFlight === false &&
                      availableCredit === 0 && unappliedValue === 0 &&
                      sourceConflict === false && attributionKnown === true &&
                      policyDecision === COLLECTION_POLICY_DECISION.ALLOWED
                    assert.equal(result.outcome === COLLECTION_ELIGIBILITY.ELIGIBLE, safe,
                      JSON.stringify({ balance, freshnessName, disputeActive, paymentInFlight,
                        availableCredit, unappliedValue, sourceConflict, attributionKnown, policyDecision }))
                    if (safe) eligible += 1
                  }
    }
  }
  assert.equal(examined, 21870)
  assert.equal(eligible, 1)
})
